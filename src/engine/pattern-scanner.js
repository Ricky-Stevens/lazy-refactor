import { execFileSync } from "node:child_process";
import { globToRegex } from "./files.js";

/** @type {boolean|null} */
let _ripgrepAvailable = null;

/**
 * Check if `rg` is on PATH. Result is cached after first call.
 * @returns {Promise<boolean>}
 */
export async function isRipgrepAvailable() {
  if (_ripgrepAvailable !== null) return _ripgrepAvailable;
  try {
    execFileSync("rg", ["--version"], { stdio: "ignore" });
    _ripgrepAvailable = true;
  } catch {
    _ripgrepAvailable = false;
  }
  return _ripgrepAvailable;
}

/**
 * Check whether a file path matches any of the given exclude globs.
 * @param {string} filePath
 * @param {string[]} excludeGlobs
 * @returns {boolean}
 */
function isExcluded(filePath, excludeGlobs) {
  const normalised = filePath.replace(/^\.\//, "");
  return excludeGlobs.some((glob) => {
    const rx = globToRegex(glob);
    return rx.test(normalised) || rx.test(normalised.split("/").pop() ?? "");
  });
}

/**
 * Extract file extensions from a filePattern glob.
 * @param {string} filePattern e.g. "**\/*.{ts,tsx,js}" or "**\/*.py"
 * @returns {string[]}
 */
function extractExtensions(filePattern) {
  const braceMatch = filePattern.match(/\{([^}]+)\}/);
  if (braceMatch) {
    return braceMatch[1].split(",").map((e) => e.trim());
  }
  const singleMatch = filePattern.match(/\*\.([a-zA-Z0-9]+)$/);
  return singleMatch ? [singleMatch[1]] : ["*"];
}

/**
 * Build find(1) arguments for a given file pattern and exclude list.
 * @param {string[]} exts
 * @param {string[]} excludes
 * @returns {string[]}
 */
function buildFindArgs(exts, excludes) {
  const args = ["."];
  args.push("(");
  for (let i = 0; i < exts.length; i++) {
    if (i > 0) args.push("-o");
    args.push("-name", `*.${exts[i]}`);
  }
  args.push(")");

  for (const e of excludes) {
    if (e.includes("*.")) {
      const stripped = e.replace(/^\*\*\//, "");
      args.push("-not", "-name", stripped);
    } else {
      const dir = e.replace(/^\*\*\//, "").replace(/\/\*\*$/, "");
      args.push("-not", "-path", `*/${dir}`, "-not", "-path", `*/${dir}/*`);
    }
  }
  args.push("-type", "f");
  return args;
}

/**
 * Enumerate files matching a pattern using find(1).
 * Uses execFileSync with argument arrays to prevent shell injection.
 * @param {string} filePattern
 * @param {string[]} excludes
 * @param {string} cwd
 * @returns {string[]} Matched file paths
 */
function enumerateFilesWithGrep(filePattern, excludes, cwd) {
  const exts = extractExtensions(filePattern);
  let raw;
  try {
    raw = execFileSync("find", buildFindArgs(exts, excludes), {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      maxBuffer: 50 * 1024 * 1024,
    }).trim();
  } catch {
    return [];
  }
  return raw ? raw.split("\n").filter(Boolean) : [];
}

/**
 * Run grep over file list in chunks to stay under ARG_MAX.
 * Uses execFileSync with argument arrays to prevent shell injection.
 * @param {string} pattern
 * @param {string[]} files
 * @param {string} cwd
 * @returns {string}
 */
function grepChunked(pattern, files, cwd) {
  const CHUNK_SIZE = 5000;
  let output = "";
  for (let i = 0; i < files.length; i += CHUNK_SIZE) {
    const chunk = files.slice(i, i + CHUNK_SIZE);
    try {
      // -H forces filename prefix even when chunk has a single file, so parseLine works.
      output += execFileSync("grep", ["-HPn", pattern, ...chunk], {
        cwd,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
        maxBuffer: 50 * 1024 * 1024,
      });
    } catch (err) {
      // grep exits 1 when no matches found in a chunk — preserve any stdout already produced.
      if (err.stdout) output += err.stdout;
    }
  }
  return output;
}

/**
 * Run a pattern search using ripgrep or grep, returning raw output.
 * Uses execFileSync with argument arrays to prevent shell injection.
 * @param {string} pattern       PCRE2 regex
 * @param {string} filePattern   Glob (e.g. "**\/*.ts")
 * @param {string[]} excludes    Glob patterns to exclude
 * @param {boolean} useRipgrep
 * @param {string} cwd           Directory to search in
 * @returns {string}             Raw grep/rg output
 */
export function runPatternSearch(pattern, filePattern, excludes, useRipgrep, cwd) {
  if (useRipgrep) {
    const args = ["-Pn", "--no-heading"];
    for (const e of excludes) {
      args.push("--glob", `!${e}`);
    }
    args.push("-g", filePattern, pattern, ".");
    return execFileSync("rg", args, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      maxBuffer: 50 * 1024 * 1024,
    });
  }

  // grep fallback: enumerate files with find then grep in chunks
  const files = enumerateFilesWithGrep(filePattern, excludes, cwd);
  if (files.length === 0) return "";
  return grepChunked(pattern, files, cwd);
}

/**
 * Parse a single line of rg/grep output into a structured finding fragment.
 * Expected format: filepath:linenum:matchtext
 * @param {string} line
 * @returns {{file: string, line: number, match: string}|null}
 */
function parseLine(line) {
  const m = line.match(/^(.+?):(\d+):(.*)$/);
  if (!m) return null;
  return {
    file: m[1].replace(/^\.\//, ""),
    line: Number.parseInt(m[2], 10),
    match: m[3].trim(),
  };
}

/**
 * Check whether a file's content matches an antiPattern.
 * Uses execFileSync with argument arrays to prevent shell injection.
 * @param {string} filePath
 * @param {string} antiPattern
 * @param {boolean} useRipgrep
 * @returns {boolean}
 */
function fileMatchesAntiPattern(filePath, antiPattern, useRipgrep) {
  try {
    const cmd = useRipgrep ? "rg" : "grep";
    const result = execFileSync(cmd, ["-Pl", antiPattern, filePath], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Build the set of files that should be excluded due to matching the antiPattern.
 * @param {string|null} antiPattern
 * @param {string[]} lines
 * @param {string} basePath
 * @param {boolean} useRipgrep
 * @returns {Set<string>}
 */
function buildAntiPatternExclusions(antiPattern, lines, basePath, useRipgrep) {
  if (!antiPattern) return new Set();
  const hitFiles = new Set(lines.map((l) => parseLine(l)?.file).filter(Boolean));
  const excluded = new Set();
  for (const file of hitFiles) {
    if (fileMatchesAntiPattern(`${basePath}/${file}`, antiPattern, useRipgrep)) {
      excluded.add(file);
    }
  }
  return excluded;
}

/**
 * Resolve raw output for a rule, handling exit-code errors from rg/grep.
 * @param {object} rule
 * @param {string[]} allExcludes
 * @param {boolean} useRipgrep
 * @param {string} path
 * @returns {string|null} raw output, or null to skip this rule
 */
function resolveRawOutput(rule, allExcludes, useRipgrep, path) {
  try {
    return runPatternSearch(rule.pattern, rule.filePattern, allExcludes, useRipgrep, path);
  } catch (err) {
    if (err.status === 1) return "";
    if (err.stdout) return err.stdout;
    return null;
  }
}

/**
 * Scan a directory for pattern matches according to the given rules.
 *
 * @param {string} path   Directory path to scan
 * @param {Array<object>} rules
 * @param {{exclude?: string[], languages?: string[]}} [options]
 * @returns {Promise<Array<object>>}
 */
export async function scanPatterns(path, rules, options = {}) {
  const { exclude: extraExcludes = [], languages = [] } = options;
  const useRipgrep = await isRipgrepAvailable();
  const findings = [];

  for (const rule of rules) {
    if (languages.length > 0) {
      const matches = rule.language === "common" || languages.includes(rule.language);
      if (!matches) continue;
    }

    const allExcludes = [...(rule.exclude || []), ...extraExcludes];
    const rawOutput = resolveRawOutput(rule, allExcludes, useRipgrep, path);
    if (rawOutput === null) continue;

    const lines = rawOutput.split("\n").filter(Boolean);
    const antiPatternExcludedFiles = buildAntiPatternExclusions(
      rule.antiPattern,
      lines,
      path,
      useRipgrep,
    );

    for (const line of lines) {
      const parsed = parseLine(line);
      if (!parsed) continue;
      if (extraExcludes.length > 0 && isExcluded(parsed.file, extraExcludes)) continue;
      if (antiPatternExcludedFiles.has(parsed.file)) continue;

      findings.push({
        ruleId: rule.id,
        file: parsed.file,
        line: parsed.line,
        match: parsed.match,
        severity: rule.severity,
        category: rule.category,
        description: rule.description,
        suggestion: rule.suggestion,
        fixable: rule.fixable,
      });
    }
  }

  return findings;
}
