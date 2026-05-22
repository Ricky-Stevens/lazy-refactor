import { isTestFile } from "./cross-ref.js";
import { collectFiles, readFilesBatched } from "./files.js";

// ---------------------------------------------------------------------------
// Check 10 — Inconsistent patterns
// ---------------------------------------------------------------------------

const CONCERN_KEYWORDS = {
  "error-handling": ["try", "catch", "throw", "Error"],
  logging: ["log", "logger", "console", "print"],
  "data-fetching": ["fetch", "axios", "http", "request"],
  config: ["config", "env", "settings", "getConfig"],
  validation: ["validate", "schema", "assert", "check"],
  "file-locking": ["lock", "flock", "lockfile", "acquireLock"],
  "process-spawning": ["execSync", "spawnSync", "child_process", "subprocess"],
  "file-io": ["readFileSync", "writeFileSync", "createReadStream", "fsPromises"],
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
  "file-locking": [
    { pattern: "exclusive file flag (wx/O_EXCL)", re: /["']wx["']|O_EXCL|O_CREAT/ },
    { pattern: "lockfile library", re: /\b(?:proper-lockfile|lockfile|fd-lock)\b/ },
    { pattern: "flock/lockf syscall", re: /\b(?:flock|lockf|fcntl\.flock)\s*\(/ },
    { pattern: "mkdir-based lock", re: /mkdir(?:Sync)?\s*\([^)]*lock/i },
  ],
  "process-spawning": [
    { pattern: "exec/execSync (shell)", re: /\bexec(?:Sync)?\s*\(/ },
    { pattern: "execFile/execFileSync (no shell)", re: /\bexecFile(?:Sync)?\s*\(/ },
    { pattern: "spawn/spawnSync", re: /\bspawn(?:Sync)?\s*\(/ },
    { pattern: "subprocess (Python)", re: /\bsubprocess\.(?:run|call|check_output|Popen)\s*\(/ },
  ],
  "file-io": [
    {
      pattern: "sync fs (readFileSync/writeFileSync)",
      re: /\b(?:readFileSync|writeFileSync|appendFileSync)\s*\(/,
    },
    { pattern: "async fs/promises", re: /\bfs\/promises\b|\bfsPromises\b|\bfs\.promises\b/ },
    { pattern: "stream I/O", re: /\bcreate(?:Read|Write)Stream\s*\(/ },
    {
      pattern: "callback fs",
      re: /\bfs\.(?:readFile|writeFile|appendFile)\s*\([^)]*,\s*(?:function|\()/,
    },
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

// Precompile keyword regexes per concern to avoid repeated construction.
const _keywordRegexes = {};
for (const [concern, keywords] of Object.entries(CONCERN_KEYWORDS)) {
  _keywordRegexes[concern] = keywords.map((kw) => new RegExp(`\\b${kw}\\b`));
}

/**
 * Scan for inconsistent coding patterns across concerns.
 * Reads each file once and checks all concerns against the stripped content.
 * @param {string} path - Directory to scan
 * @param {object} [options]
 * @param {string[]} [options.exclude]
 * @param {string[]} [options.languages]
 * @returns {Promise<Array<{check: string, concern: string, approaches: Array<{pattern: string, files: string[], count: number}>}>>}
 */
export async function scanInconsistentPatterns(path, options = {}) {
  const files = await collectFiles(path, options);
  const contents = await readFilesBatched(files);

  const concerns = Object.entries(CONCERN_KEYWORDS);
  const approachFilesByConcern = {};
  for (const [concern] of concerns) {
    approachFilesByConcern[concern] = {};
    for (const { pattern } of approachPatterns[concern] ?? []) {
      approachFilesByConcern[concern][pattern] = [];
    }
  }

  for (const [file, content] of contents) {
    if (isTestFile(file)) continue;
    const stripped = stripNoise(content);

    for (const [concern] of concerns) {
      const hasConcern = _keywordRegexes[concern].some((rx) => rx.test(stripped));
      if (!hasConcern) continue;

      const approaches = matchedApproaches(concern, stripped);
      for (const pattern of approaches) {
        approachFilesByConcern[concern][pattern].push(file);
      }
    }
  }

  const findings = [];
  for (const [concern] of concerns) {
    const usedApproaches = Object.entries(approachFilesByConcern[concern])
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
