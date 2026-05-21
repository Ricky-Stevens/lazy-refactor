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

const CONFIG_FILE = ".lazy-refactor.json";

const DEFAULT_CONFIG = {
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
const LANGUAGE_RULES = {
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

