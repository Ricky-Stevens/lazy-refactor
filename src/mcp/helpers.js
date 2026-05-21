/**
 * Shared constants and helper utilities for the lazy-refactor MCP server.
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// Language-specific rule sets
import commonRules from "../rules/common.js";
import csharpRules from "../rules/csharp.js";
import goRules from "../rules/go.js";
import javaRules from "../rules/java.js";
import pythonRules from "../rules/python.js";
import typescriptRules from "../rules/typescript.js";

// ─── Constants ────────────────────────────────────────────────────────────────

export const CONFIG_FILE = ".lazy-refactor.json";

export const DEFAULT_CONFIG = {
  thresholds: {
    maxFileLines: 300,
    maxComplexity: 15,
    maxNesting: 4,
    maxExportsPerFile: 10,
    maxImportsPerFile: 15,
    duplicateMinTokens: 50,
    duplicateSimilarity: 0.8,
  },
  exclude: ["vendor/**", "generated/**", "*.generated.*", "node_modules/**", ".git/**"],
  disabledChecks: [],
  languages: "auto",
};

/** Language name -> rule array */
export const LANGUAGE_RULES = {
  typescript: typescriptRules,
  go: goRules,
  python: pythonRules,
  csharp: csharpRules,
  java: javaRules,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Deep-merge two plain objects. Arrays in `override` replace those in `base`.
 * @param {object} base
 * @param {object} override
 * @returns {object}
 */
export function deepMerge(base, override) {
  const result = { ...base };
  for (const [key, val] of Object.entries(override)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (
      val !== null &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

/**
 * Validate and resolve a scan path. Ensures it exists and is a directory.
 * @param {string} inputPath
 * @returns {Promise<string>} resolved absolute path
 */
export async function validateScanPath(inputPath) {
  const resolved = resolve(inputPath);
  const info = await stat(resolved);
  if (!info.isDirectory()) {
    throw new Error(`Path is not a directory: ${resolved}`);
  }
  return resolved;
}

/**
 * Read and merge project config with defaults.
 * @param {string} projectPath
 * @returns {Promise<object>}
 */
export async function readConfig(projectPath) {
  try {
    const raw = await readFile(join(projectPath, CONFIG_FILE), "utf8");
    const disk = JSON.parse(raw);
    return deepMerge(DEFAULT_CONFIG, disk);
  } catch (err) {
    if (err.code === "ENOENT") return { ...DEFAULT_CONFIG };
    throw err;
  }
}

/**
 * Write config to disk (only the non-default parts are written, but we write
 * the full merged object for simplicity / auditability).
 * @param {string} projectPath
 * @param {object} config
 */
export async function writeConfig(projectPath, config) {
  await writeFile(join(projectPath, CONFIG_FILE), JSON.stringify(config, null, 2), "utf8");
}

/**
 * Build the combined rule set for the detected languages.
 * Always includes common rules.
 * @param {string[]} languages
 * @returns {Array}
 */
export function buildRules(languages) {
  // Start with common rules that apply to all languages
  const rules = [...commonRules];
  for (const lang of languages) {
    if (LANGUAGE_RULES[lang]) {
      rules.push(...LANGUAGE_RULES[lang]);
    }
  }
  return rules;
}

/**
 * Wrap a result as an MCP success content block.
 * @param {unknown} data
 * @returns {{content: Array<{type: string, text: string}>}}
 */
export function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

/**
 * Wrap an error as an MCP error content block (does not throw).
 * @param {unknown} err
 * @returns {{content: Array<{type: string, text: string}>, isError: true}}
 */
export function fail(err) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

// ─── Finding mappers (used by run_scan in tools-scan.js) ─────────────────────

export function mapDupe(f) {
  return {
    check: f.check,
    severity: "medium",
    category: "duplication",
    locations: [{ file: f.fileA, startLine: f.startLineA, endLine: f.endLineA }],
    description: `Duplicate code block between ${f.fileA} and ${f.fileB}`,
    similarity: f.similarity,
    tokenCount: f.tokenCount,
    fileB: f.fileB,
    startLineB: f.startLineB,
    endLineB: f.endLineB,
    suggestion: "Extract shared logic into a reusable function or module.",
    fixable: false,
    confidence: f.similarity,
    language: f.language ?? "common",
  };
}

export function mapDeadExport(f, resolvedPath) {
  return {
    check: f.check,
    severity: "low",
    category: "dead-code",
    locations: [{ file: f.file.replace(`${resolvedPath}/`, ""), startLine: f.exportLine + 1 }],
    description: `Exported symbol '${f.symbol}' appears unused`,
    symbol: f.symbol,
    suggestion: "Remove the export or verify it is consumed externally.",
    fixable: false,
    confidence: f.confidence,
    language: f.language ?? "common",
  };
}

export function mapUnusedDep(f) {
  return {
    check: f.check,
    severity: "low",
    category: "dead-code",
    locations: [],
    description: `Dependency '${f.dep}' declared in ${f.manifest} manifest but not referenced in source`,
    dep: f.dep,
    suggestion: "Remove the dependency or verify it is used via dynamic require.",
    fixable: false,
    confidence: 0.7,
    language: f.language ?? "common",
  };
}

export function mapUnusedImport(f, resolvedPath) {
  return {
    check: f.check,
    severity: "low",
    category: "dead-code",
    locations: [{ file: f.file.replace(`${resolvedPath}/`, ""), startLine: f.importLine + 1 }],
    description: `Import '${f.symbol}' is never used`,
    symbol: f.symbol,
    suggestion: "Remove the unused import.",
    fixable: true,
    confidence: 0.85,
    language: f.language ?? "common",
  };
}

export function mapMetric(f) {
  return {
    check: f.ruleId,
    severity: f.severity,
    category: f.category,
    locations: [{ file: f.file, startLine: f.line }],
    description: f.description,
    suggestion: f.suggestion,
    fixable: f.fixable,
    confidence: 0.95,
    language: f.language ?? "common",
  };
}

export function mapPattern(f) {
  return {
    check: f.ruleId,
    severity: f.severity,
    category: f.category,
    locations: [{ file: f.file, startLine: f.line }],
    description: f.description,
    suggestion: f.suggestion,
    fixable: f.fixable,
    confidence: 0.9,
    language: f.language ?? "common",
  };
}

export function mapInconsistent(f, resolvedPath) {
  return {
    check: f.check ?? "inconsistent-pattern",
    severity: f.severity ?? "low",
    category: f.category ?? "consistency",
    locations:
      f.locations ??
      (f.file ? [{ file: f.file.replace(`${resolvedPath}/`, ""), startLine: f.line ?? 1 }] : []),
    description: f.description,
    suggestion:
      f.suggestion ?? "Align with the predominant pattern used elsewhere in the codebase.",
    fixable: f.fixable ?? false,
    confidence: f.confidence ?? 0.75,
    language: f.language ?? "common",
  };
}

export function mapOverEngineering(f, resolvedPath) {
  return {
    check: f.check ?? "over-engineering",
    severity: f.severity ?? "low",
    category: f.category ?? "complexity",
    locations:
      f.locations ??
      (f.file ? [{ file: f.file.replace(`${resolvedPath}/`, ""), startLine: f.line ?? 1 }] : []),
    description: f.description,
    suggestion: f.suggestion ?? "Simplify to the minimum viable abstraction.",
    fixable: f.fixable ?? false,
    confidence: f.confidence ?? 0.7,
    language: f.language ?? "common",
  };
}
