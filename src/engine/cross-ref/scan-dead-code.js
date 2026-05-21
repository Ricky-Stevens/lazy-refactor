import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { collectFiles } from "../files.js";
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
 * Scan for dead code (exported symbols with no matching imports anywhere else).
 * @param {string} path - Directory to scan
 * @param {object} [rules] - Optional rule overrides (unused currently; patterns are built-in)
 * @param {object} [options]
 * @param {string[]} [options.exclude]
 * @param {string[]} [options.languages]
 * @returns {Promise<Array<{check: string, file: string, symbol: string, exportLine: number, confidence: number}>>}
 */
export async function scanDeadCode(path, _rules = {}, options = {}) {
  const files = await collectFiles(path, options);

  // Step 1: extract exports and imports per file
  const fileData = [];
  for (const file of files) {
    const language = detectLanguage(file);
    if (!language) continue;
    let content;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const exports = extractExports(content, language);
    const imports = extractImports(content, language);
    fileData.push({ file, language, content, exports, imports });
  }

  // Step 2: build per-language import sets to avoid cross-language false negatives
  // (e.g. TS and Python sharing common names like "parse", "validate", "transform")
  const importsByLanguage = {};
  for (const { language, imports } of fileData) {
    if (!importsByLanguage[language]) importsByLanguage[language] = new Set();
    for (const sym of imports) {
      importsByLanguage[language].add(sym);
    }
  }

  // Step 3: cross-reference — exports with zero matching imports = dead code
  // Optionally boost confidence for recently-added files (likely AI pivot debris)
  const recentFiles = await getRecentlyAddedFiles(path, 30);

  const findings = [];
  for (const { file, language, exports } of fileData) {
    // Skip entry points and test files
    if (isEntryPoint(file) || isTestFile(file)) continue;

    let baseConfidence = language === "python" ? 0.6 : 0.9;
    // Boost confidence for files recently added to git — more likely to be unused pivot code
    if (recentFiles.has(file)) baseConfidence = Math.min(1, baseConfidence + 0.05);

    for (const exp of exports) {
      const { name, line } = exp;
      // Go imports packages, not symbols — import sets will never contain
      // Go exported symbol names. Instead, grep all other Go file content for the
      // symbol name as a word boundary match.
      if (language === "go") {
        const otherContents = fileData
          .filter((fd) => fd.file !== file && fd.file.endsWith(".go"))
          .map((fd) => fd.content)
          .join("\n");
        const used = new RegExp(`\\b${name}\\b`).test(otherContents);
        if (!used) {
          findings.push({
            check: "dead-code",
            file,
            symbol: name,
            exportLine: line,
            confidence: 0.7,
          });
        }
        continue;
      }

      // C# namespace using directives don't map to symbol names — grep other
      // .cs files for the symbol as a word boundary match (same approach as Go).
      if (language === "csharp") {
        const otherContents = fileData
          .filter((fd) => fd.file !== file && fd.file.endsWith(".cs"))
          .map((fd) => fd.content)
          .join("\n");
        const used = new RegExp(`\\b${name}\\b`).test(otherContents);
        if (!used) {
          findings.push({
            check: "dead-code",
            file,
            symbol: name,
            exportLine: line,
            confidence: 0.7,
          });
        }
        continue;
      }

      // For TS/Python/Java: check against the matching language's import set
      const langImports = importsByLanguage[language] ?? new Set();

      // Python: decorated functions/classes get lower confidence (0.3) because
      // decorators like @app.route, @pytest.fixture etc. register symbols
      // without explicit imports (~60-100 FPs per Flask project otherwise).
      let confidence = baseConfidence;
      if (language === "python" && exp.decorated) {
        confidence = 0.3;
      }

      if (!langImports.has(name)) {
        findings.push({
          check: "dead-code",
          file,
          symbol: name,
          exportLine: line,
          confidence,
        });
      }
    }
  }

  return findings;
}
