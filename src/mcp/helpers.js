import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import commonRules from "../rules/common.js";
import csharpRules from "../rules/csharp.js";
import goRules from "../rules/go.js";
import javaRules from "../rules/java.js";
import pythonRules from "../rules/python.js";
import typescriptRules from "../rules/typescript.js";

const CONFIG_FILE = ".lazy-refactor.json";

const DEFAULT_CONFIG = {
  thresholds: {
    maxFileLines: 300,
    maxComplexity: 100,
    maxNesting: 4,
    maxExportsPerFile: 10,
    maxImportsPerFile: 15,
    duplicateMinTokens: 100,
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

// Arrays in override replace (not merge with) those in base
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

export async function validateScanPath(inputPath) {
  const resolved = resolve(inputPath);
  const info = await stat(resolved);
  if (!info.isDirectory()) {
    throw new Error(`Path is not a directory: ${resolved}`);
  }
  return resolved;
}

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

// Writes the full merged object rather than a diff for auditability
export async function writeConfig(projectPath, config) {
  await writeFile(join(projectPath, CONFIG_FILE), JSON.stringify(config, null, 2), "utf8");
}

// Always includes common rules
export function buildRules(languages) {
  const rules = [...commonRules];
  for (const lang of languages) {
    if (LANGUAGE_RULES[lang]) {
      rules.push(...LANGUAGE_RULES[lang]);
    }
  }
  return rules;
}

export function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

// Redact the user's home directory and cwd from error text so a raw filesystem
// or SQLite error (e.g. "...unable to open /home/<user>/...") doesn't leak the
// local username/layout back to the MCP client. Intentional messages (e.g.
// "Finding 'x' not found") contain none of these and pass through unchanged.
function redactPaths(message) {
  // Redact the longer path first: cwd is typically nested under HOME, so replacing
  // HOME first would partially rewrite cwd and leave it uncollapsed.
  const roots = [process.env.HOME, process.cwd()]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  let out = message;
  for (const root of roots) out = out.split(root).join("~");
  return out;
}

export function fail(err) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: JSON.stringify({ error: redactPaths(message) }) }],
    isError: true,
  };
}
