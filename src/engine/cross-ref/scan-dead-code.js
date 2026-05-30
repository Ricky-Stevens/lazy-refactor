import { execFile } from "node:child_process";
import { join } from "node:path";
import { collectFiles, readFilesBatched } from "../files.js";
import { detectLanguage, isEntryPoint, isTestFile } from "./classify.js";
import { extractExports } from "./extract-exports.js";
import { extractImports } from "./extract-imports.js";

/**
 * Return a Set of absolute file paths that were added to git within the last `days` days.
 * Returns an empty Set if git is unavailable or the directory is not a repository.
 * @param {string} repoPath
 * @param {number} [days=30]
 * @returns {Promise<Set<string>>}
 */
export async function getRecentlyAddedFiles(repoPath, days = 30) {
  return new Promise((resolve) => {
    const args = [
      "-C",
      repoPath,
      "log",
      "--diff-filter=A",
      `--since=${days} days ago`,
      "--name-only",
      "--pretty=format:",
    ];
    execFile(
      "git",
      args,
      { timeout: 10000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(new Set());
          return;
        }
        const files = stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((rel) => join(repoPath, rel));
        resolve(new Set(files));
      },
    );
  });
}

/**
 * Count whole-word occurrences of `name` in `text`.
 * @param {string} name
 * @param {string} text
 * @returns {number}
 */
function countWordMatches(name, text) {
  if (!text) return 0;
  const matches = text.match(new RegExp(`\\b${name}\\b`, "g"));
  return matches ? matches.length : 0;
}

/**
 * Determine whether a single exported symbol is unused.
 * Returns a finding object if unused, or null if the symbol is in use.
 *
 * Go and C# use grep-based matching against the precomputed same-language
 * corpus (import sets don't capture individual symbol names for those
 * languages). The corpus is built ONCE for the whole scan, so the symbol's
 * OWN file is included; self-references are subtracted by comparing the
 * whole-corpus match count against the own-file match count — a symbol is
 * "used" only if it appears in some OTHER file of the same language. This
 * preserves the prior per-export self-exclusion semantic without rebuilding
 * the corpus on every export.
 * For TS/Python/Java the per-language import set is used.
 */
function checkExport(exp, file, language, ownContent, corpus, importsByLanguage, baseConfidence) {
  const { name, line } = exp;

  // Go: match the precomputed .go corpus, excluding the symbol's own file.
  if (language === "go") {
    if (countWordMatches(name, corpus.go) > countWordMatches(name, ownContent)) return null;
    return { check: "dead-code", file, symbol: name, exportLine: line, confidence: 0.7 };
  }

  // C#: namespace `using` directives don't map to symbol names — match the .cs corpus.
  if (language === "csharp") {
    if (countWordMatches(name, corpus.csharp) > countWordMatches(name, ownContent)) return null;
    return { check: "dead-code", file, symbol: name, exportLine: line, confidence: 0.7 };
  }

  // TS/Python/Java: check against the per-language import set.
  const langImports = importsByLanguage[language] ?? new Set();

  // Python decorated symbols get lower confidence — decorators like @app.route
  // register symbols implicitly without explicit imports (~60-100 FPs per Flask project).
  let confidence = baseConfidence;
  if (language === "python" && exp.decorated) confidence = 0.3;

  if (langImports.has(name)) return null;
  return { check: "dead-code", file, symbol: name, exportLine: line, confidence };
}

/**
 * Scan for dead code (exported symbols with no matching imports anywhere else).
 * @param {string} path - Directory to scan
 * @param {object} [_rules] - Reserved for future rule overrides (unused)
 * @param {object} [options]
 * @param {string[]} [options.exclude]
 * @param {string[]} [options.languages]
 * @returns {Promise<Array<{check: string, file: string, symbol: string, exportLine: number, confidence: number}>>}
 */
export async function scanDeadCode(path, _rules = {}, options = {}) {
  const files = await collectFiles(path, options);
  const contents = await readFilesBatched(files);

  const fileData = [];
  for (const [file, content] of contents) {
    const language = detectLanguage(file);
    if (!language) continue;
    const exports = extractExports(content, language);
    const imports = extractImports(content, language);
    fileData.push({ file, language, content, exports, imports });
  }

  // Per-language import sets prevent cross-language false negatives
  // (e.g. TS and Python sharing common names like "parse" or "transform").
  const importsByLanguage = {};
  for (const { language, imports } of fileData) {
    if (!importsByLanguage[language]) importsByLanguage[language] = new Set();
    for (const sym of imports) importsByLanguage[language].add(sym);
  }

  // Precompute the per-language source corpus ONCE (not per export) for the
  // grep-based Go/C# dead-code checks. Rebuilding this inside the export loop
  // was O(exports × totalContent) — quadratic on large repos.
  const corpus = {
    go: fileData
      .filter((fd) => fd.language === "go")
      .map((fd) => fd.content)
      .join("\n"),
    csharp: fileData
      .filter((fd) => fd.language === "csharp")
      .map((fd) => fd.content)
      .join("\n"),
  };

  // Recently-added files get a small confidence boost — more likely to be
  // pivot debris left over from abandoned AI-assisted refactors.
  const recentFiles = await getRecentlyAddedFiles(path, 30);

  const findings = [];
  for (const { file, language, content, exports } of fileData) {
    if (isEntryPoint(file) || isTestFile(file)) continue;

    let baseConfidence = language === "python" ? 0.6 : 0.9;
    if (recentFiles.has(file)) baseConfidence = Math.min(1, baseConfidence + 0.05);

    for (const exp of exports) {
      const finding = checkExport(
        exp,
        file,
        language,
        content,
        corpus,
        importsByLanguage,
        baseConfidence,
      );
      if (finding) findings.push(finding);
    }
  }

  return findings;
}
