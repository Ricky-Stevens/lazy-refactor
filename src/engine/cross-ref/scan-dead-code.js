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
    execFile("git", args, (err, stdout) => {
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
    });
  });
}

/**
 * Determine whether a single exported symbol is unused.
 * Returns a finding object if unused, or null if the symbol is in use.
 *
 * Go and C# use grep-based matching against other files of the same language
 * (import sets don't capture individual symbol names for those languages).
 * For TS/Python/Java the per-language import set is used.
 */
function checkExport(exp, file, language, fileData, importsByLanguage, baseConfidence) {
  const { name, line } = exp;

  // Go: grep other .go files for the symbol name.
  if (language === "go") {
    const otherContent = fileData
      .filter((fd) => fd.file !== file && fd.file.endsWith(".go"))
      .map((fd) => fd.content)
      .join("\n");
    if (new RegExp(`\\b${name}\\b`).test(otherContent)) return null;
    return { check: "dead-code", file, symbol: name, exportLine: line, confidence: 0.7 };
  }

  // C#: namespace `using` directives don't map to symbol names — grep other .cs files.
  if (language === "csharp") {
    const otherContent = fileData
      .filter((fd) => fd.file !== file && fd.file.endsWith(".cs"))
      .map((fd) => fd.content)
      .join("\n");
    if (new RegExp(`\\b${name}\\b`).test(otherContent)) return null;
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

  // Recently-added files get a small confidence boost — more likely to be
  // pivot debris left over from abandoned AI-assisted refactors.
  const recentFiles = await getRecentlyAddedFiles(path, 30);

  const findings = [];
  for (const { file, language, exports } of fileData) {
    if (isEntryPoint(file) || isTestFile(file)) continue;

    let baseConfidence = language === "python" ? 0.6 : 0.9;
    if (recentFiles.has(file)) baseConfidence = Math.min(1, baseConfidence + 0.05);

    for (const exp of exports) {
      const finding = checkExport(exp, file, language, fileData, importsByLanguage, baseConfidence);
      if (finding) findings.push(finding);
    }
  }

  return findings;
}
