import { readFile } from "node:fs/promises";
import { isTestFile } from "./cross-ref.js";
import { collectFiles } from "./files.js";

// ---------------------------------------------------------------------------
// Check 10 — Inconsistent patterns
// ---------------------------------------------------------------------------

const CONCERN_KEYWORDS = {
  "error-handling": ["try", "catch", "throw", "Error"],
  logging: ["log", "logger", "console", "print"],
  "data-fetching": ["fetch", "axios", "http", "request"],
  config: ["config", "env", "settings", "getConfig"],
  validation: ["validate", "schema", "assert", "check"],
};

// Approach-detection patterns per concern
const approachPatterns = {
  "error-handling": [
    { pattern: "try/catch with custom Error", re: /throw\s+new\s+[A-Z][A-Za-z]*Error/ },
    {
      pattern: "try/catch",
      re: /\btry\s*\{[\s\S]*?\bcatch\b/,
      preFilter: (c) => /\btry\b/.test(c) && /\bcatch\b/.test(c),
    },
    { pattern: "promise .catch()", re: /\.catch\s*\(/ },
    { pattern: "error callback (err, data)", re: /function\s*\([^)]*\berr\b/ },
  ],
  logging: [
    { pattern: "console.*", re: /\bconsole\.(log|warn|error|info|debug)\s*\(/ },
    { pattern: "logger object", re: /\blogger\.(log|warn|error|info|debug)\s*\(/ },
    { pattern: "log() call", re: /\blog\s*\(/ },
    { pattern: "print()", re: /\bprint\s*\(/ },
  ],
  "data-fetching": [
    { pattern: "fetch API", re: /\bfetch\s*\(/ },
    { pattern: "axios", re: /\baxios\b/ },
    { pattern: "http/https module", re: /\bhttp(s)?\.request\b|\bhttp(s)?\.get\b/ },
    { pattern: "request library", re: /\brequest\s*\(/ },
  ],
  config: [
    { pattern: "process.env", re: /\bprocess\.env\b/ },
    { pattern: "getConfig()", re: /\bgetConfig\s*\(/ },
    { pattern: "config object", re: /\bconfig\s*\.\s*[A-Za-z]/ },
    { pattern: "settings object", re: /\bsettings\s*\.\s*[A-Za-z]/ },
  ],
  validation: [
    { pattern: "schema validation (zod/yup/joi)", re: /\b(z\.|yup\.|joi\.)/ },
    { pattern: "assert()", re: /\bassert\s*\(/ },
    { pattern: "validate()", re: /\bvalidate\s*\(/ },
    { pattern: "manual check (if !x throw)", re: /if\s*\(![^)]+\)\s*(throw|return)/ },
  ],
};

/**
 * Strip comments and string/regex literals so concern-keyword and approach
 * detection don't fire on pattern definitions or documentation.
 * Not a full parser — good enough to drop the obvious false-positives.
 * @param {string} content
 * @returns {string}
 */
function stripNoise(content) {
  return (
    content
      // Block and line comments, hash comments (Python/Ruby)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
      .replace(/^\s*#[^\n]*/gm, "")
      // String literals (template, double-quoted, single-quoted)
      .replace(/`[^`]*`/g, '""')
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      // Regex literals (preceded by operator/punctuation/whitespace)
      .replace(/(?<=[=({[,;!&|?:\s])\/[^/\n]+\/[gimsuy]*/g, '""')
  );
}

/**
 * Return the approach patterns (from approachPatterns[concern]) that match
 * within a stripped file body.
 * @param {string} concern
 * @param {string} stripped
 * @returns {string[]} matched pattern labels
 */
function matchedApproaches(concern, stripped) {
  const matched = [];
  for (const { pattern, re, preFilter } of approachPatterns[concern] ?? []) {
    if (preFilter && !preFilter(stripped)) continue;
    if (re.test(stripped)) matched.push(pattern);
  }
  return matched;
}

/**
 * Read a file, strip noise, and return matched approaches for the given concern.
 * Returns null if the file cannot be read or doesn't mention the concern keywords.
 * @param {string} file
 * @param {string} concern
 * @param {string[]} keywords
 * @returns {Promise<string[]|null>}
 */
async function fileApproaches(file, concern, keywords) {
  let content;
  try {
    content = await readFile(file, "utf8");
  } catch {
    return null;
  }

  const stripped = stripNoise(content);

  // Only care about files that mention at least one concern keyword (word-boundary to avoid
  // substring false-positives like "log" matching "dialog" or "catalog")
  const hasConcern = keywords.some((kw) => new RegExp(`\\b${kw}\\b`).test(stripped));
  if (!hasConcern) return null;

  return matchedApproaches(concern, stripped);
}

/**
 * Scan for inconsistent coding patterns across concerns.
 * Flags concerns where 3+ different approaches are found across the codebase.
 * @param {string} path - Directory to scan
 * @param {object} [options]
 * @param {string[]} [options.exclude]
 * @param {string[]} [options.languages]
 * @returns {Promise<Array<{check: string, concern: string, approaches: Array<{pattern: string, files: string[], count: number}>}>>}
 */
export async function scanInconsistentPatterns(path, options = {}) {
  const files = await collectFiles(path, options);
  const findings = [];

  for (const [concern, keywords] of Object.entries(CONCERN_KEYWORDS)) {
    // Map approach pattern label -> list of files using it
    const approachFiles = {};
    for (const { pattern } of approachPatterns[concern] ?? []) {
      approachFiles[pattern] = [];
    }

    for (const file of files) {
      if (isTestFile(file)) continue;
      const approaches = await fileApproaches(file, concern, keywords);
      if (!approaches) continue;
      for (const pattern of approaches) {
        approachFiles[pattern].push(file);
      }
    }

    // Collect approaches that are actually used (at least one file).
    // Note: existing tests rely on a single-file approach being counted; raising
    // this to >=2 was considered but would break that contract. Comment-stripping
    // (above) is the more impactful precision fix here.
    const usedApproaches = Object.entries(approachFiles)
      .filter(([, fileList]) => fileList.length > 0)
      .map(([pattern, fileList]) => ({ pattern, files: fileList, count: fileList.length }));

    if (usedApproaches.length >= 3) {
      findings.push({
        check: "inconsistent-patterns",
        concern,
        approaches: usedApproaches,
        description: `Inconsistent ${concern} patterns: ${usedApproaches.length} different approaches found`,
      });
    }
  }

  return findings;
}
