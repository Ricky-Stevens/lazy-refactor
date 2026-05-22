import { collectFiles, readFilesBatched } from "../files.js";
import { detectLanguage, isTestFile } from "./classify.js";
import { extractExports } from "./extract-exports.js";

const RE_EXPORT_FROM = /^\s*export\s+\{[^}]*\}\s+from\s+/;

function isReExport(lines, lineNum) {
  return RE_EXPORT_FROM.test(lines[lineNum] ?? "");
}

/**
 * A name is "specific enough" to flag when exported from multiple files.
 * Multi-segment camelCase/PascalCase or snake_case names of 6+ chars qualify.
 * Single-word names must be 12+ chars to avoid flagging common names like
 * `parse`, `render`, `handle` that legitimately appear in unrelated modules.
 */
function isSpecificName(name) {
  if (/[a-z][A-Z]/.test(name)) return name.length >= 6;
  if (name.includes("_") && name.split("_").filter(Boolean).length >= 2) return name.length >= 6;
  return name.length >= 12;
}

/**
 * Scan for the same symbol name exported from multiple files.
 * Flags potential duplicated or divergent implementations.
 * @param {string} path
 * @param {object} [options]
 * @param {string[]} [options.exclude]
 * @param {string[]} [options.languages]
 * @returns {Promise<Array<{check: string, symbol: string, locations: Array<{file: string, line: number}>, fileCount: number, description: string}>>}
 */
export async function scanDivergentExports(path, options = {}) {
  const files = await collectFiles(path, options);
  const contents = await readFilesBatched(files);
  const exportIndex = new Map();

  for (const [file, content] of contents) {
    if (isTestFile(file)) continue;
    const language = detectLanguage(file);
    if (!language) continue;

    const exports = extractExports(content, language);
    const lines = content.split("\n");

    for (const exp of exports) {
      if (language === "typescript" && isReExport(lines, exp.line)) continue;
      if (!exportIndex.has(exp.name)) exportIndex.set(exp.name, []);
      exportIndex.get(exp.name).push({ file, line: exp.line });
    }
  }

  const findings = [];
  for (const [name, locations] of exportIndex) {
    const uniqueFiles = [...new Set(locations.map((l) => l.file))];
    if (uniqueFiles.length < 2) continue;
    if (!isSpecificName(name)) continue;

    findings.push({
      check: "divergent-export",
      symbol: name,
      locations: locations.map((l) => ({ file: l.file, line: l.line })),
      fileCount: uniqueFiles.length,
      description: `Symbol '${name}' is exported from ${uniqueFiles.length} different files — may indicate duplicated or divergent implementations`,
    });
  }

  return findings;
}
