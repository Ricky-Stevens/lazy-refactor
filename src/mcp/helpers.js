import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expandIgnorePatterns } from "../engine/ignore-list.js";
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
  // Vendored/minified/generated artifacts are noise, not first-party source: a
  // single vendored blob (e.g. public/tesseract/*.min.js) otherwise produces a
  // false "critical" (eval) and a wall of empty-catch "high" findings. Test files
  // are deliberately NOT excluded here — they're handled with raised thresholds in
  // metrics.js so real smells (empty catch, eval) are still caught in tests.
  exclude: [
    "vendor/**",
    "generated/**",
    "*.generated.*",
    "node_modules/**",
    ".git/**",
    "public/**",
    "**/*.min.js",
    "**/*.wasm.js",
    "**/*.d.ts",
    // Generated coverage/report output (e.g. coverage-merged/, jscpd-report/) is not
    // first-party source. SKIP_DIRS already nets the exact `coverage`/`out` dirs;
    // these globs catch the named variants common tools emit. Deliberately NOT a
    // broad `*-report` glob — that would silently skip a legit source dir like
    // `incident-report/`. Override-able per project for other tool outputs.
    "**/coverage*/**",
    "**/jscpd-report/**",
    "**/playwright-report/**",
  ],
  disabledChecks: [],
  // User-curated list of project-relative files/dirs to permanently skip — kept
  // SEPARATE from `exclude` (default noise globs) and `.gitignore` so a user can
  // flag one-off things (seed/test scripts, fixtures) without polluting either.
  // Expanded into exclude globs at scan time via `effectiveExclude`.
  ignore: [],
  languages: "auto",
  // Respect .gitignore (via `git check-ignore`) so generated/vendored artifacts
  // already ignored by the project aren't scanned. No-ops outside a git repo.
  respectGitignore: true,
};

/** Language name -> rule array */
const LANGUAGE_RULES = {
  typescript: typescriptRules,
  // .js/.jsx are covered by LANGUAGE_EXTENSIONS.typescript and matched by the
  // TS/JS rule set, so an explicit 'javascript' override aliases the same rules.
  javascript: typescriptRules,
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
  let info;
  try {
    info = await stat(resolved);
  } catch (err) {
    // Replace raw node errors (which leak the statx syscall name and are not
    // redacted by redactPaths since the scan path may be outside HOME/cwd)
    // with clean messages mirroring the not-a-directory branch below.
    if (err.code === "ENOENT") throw new Error(`Directory not found: ${resolved}`);
    if (err.code === "EACCES") throw new Error(`Permission denied reading: ${resolved}`);
    throw err;
  }
  if (!info.isDirectory()) {
    throw new Error(`Path is not a directory: ${resolved}`);
  }
  return resolved;
}

// Coerce malformed on-disk overrides back to types the engine contract expects.
// deepMerge replaces (rather than merges) any non-plain-object override, so a
// user writing a string/null where an array/object is expected would otherwise
// crash the scan downstream (compileExcludes/array spreads, thresholds derefs).
// Normalization belongs here at the config boundary, not in the engine.
function normalizeConfig(merged) {
  for (const key of ["exclude", "disabledChecks", "ignore"]) {
    if (typeof merged[key] === "string") merged[key] = [merged[key]];
    else if (!Array.isArray(merged[key])) merged[key] = [...DEFAULT_CONFIG[key]];
  }
  if (
    typeof merged.thresholds !== "object" ||
    merged.thresholds === null ||
    Array.isArray(merged.thresholds)
  ) {
    merged.thresholds = { ...DEFAULT_CONFIG.thresholds };
  }
  // Only an explicit `false` disables gitignore respect; any other malformed
  // value falls back to the safe default (on).
  if (typeof merged.respectGitignore !== "boolean") merged.respectGitignore = true;
  return merged;
}

export async function readConfig(projectPath) {
  try {
    const raw = await readFile(join(projectPath, CONFIG_FILE), "utf8");
    const disk = JSON.parse(raw);
    return normalizeConfig(deepMerge(DEFAULT_CONFIG, disk));
  } catch (err) {
    if (err.code === "ENOENT") return { ...DEFAULT_CONFIG };
    throw err;
  }
}

// Writes the full merged object rather than a diff for auditability. Written
// atomically (temp file + rename) so a crash mid-write can't truncate the user's
// whole config — a plain writeFile here would risk losing exclude/thresholds/
// disabledChecks, not just the field being changed. rename(2) within a directory
// is atomic on POSIX; a leftover temp file on failure is cleaned up best-effort.
export async function writeConfig(projectPath, config) {
  const target = join(projectPath, CONFIG_FILE);
  const tmp = `${target}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(config, null, 2), "utf8");
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
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

/**
 * Compose the full exclude set for a scan: the config `exclude` noise globs, the
 * user-curated `ignore` list (expanded to globs), and any per-call extras. Single
 * source of truth so every scan entry point (run/resume + the focused scans)
 * applies the ignore list identically — there's no per-scanner threading.
 * @param {object} config
 * @param {string[]} [extra]
 * @returns {string[]}
 */
export function effectiveExclude(config, extra = []) {
  return [...config.exclude, ...expandIgnorePatterns(config.ignore), ...extra];
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
