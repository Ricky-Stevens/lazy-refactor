import { readFile } from "node:fs/promises";
import { collectFiles } from "./files.js";
import { computeFileMetrics } from "./metrics-compute.js";

export { computeFileMetrics, isPythonFile } from "./metrics-compute.js";

/**
 * Compute metrics for all source files under a directory.
 *
 * @param {string} path   Directory to scan
 * @param {{
 *   maxFileLines?: number,
 *   maxComplexity?: number,
 *   maxNesting?: number,
 *   maxExportsPerFile?: number,
 *   maxImportsPerFile?: number,
 *   languages?: string[],
 *   exclude?: string[]
 * }} [options]
 * @returns {Promise<{
 *   fileMetrics: Array<{
 *     file: string,
 *     lineCount: number,
 *     maxNestingDepth: number,
 *     branchPointCount: number,
 *     commentToCodeRatio: number,
 *     exportCount: number,
 *     importCount: number,
 *     complexityScore: number
 *   }>,
 *   findings: Array<{
 *     ruleId: string,
 *     file: string,
 *     line: number,
 *     match: string,
 *     severity: string,
 *     category: string,
 *     description: string,
 *     suggestion: string,
 *     fixable: boolean
 *   }>
 * }>}
 */
export async function computeMetrics(path, options = {}) {
  const {
    maxFileLines = 300,
    maxComplexity = 15,
    maxNesting = 4,
    maxExportsPerFile = 10,
    maxImportsPerFile = 15,
    languages = [],
    exclude = [],
  } = options;

  const filePaths = await collectFiles(path, {
    exclude,
    languages: languages.length > 0 ? languages : undefined,
  });

  const fileMetrics = [];
  const findings = [];

  for (const filePath of filePaths) {
    let content;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      // Unreadable file — skip
      continue;
    }

    const metrics = computeFileMetrics(content, filePath);
    const relativePath = filePath.startsWith(path)
      ? filePath.slice(path.length).replace(/^\//, "")
      : filePath;

    fileMetrics.push({ file: relativePath, ...metrics });

    // Emit threshold findings
    if (metrics.lineCount > maxFileLines) {
      findings.push({
        ruleId: "metrics-long-file",
        file: relativePath,
        line: 1,
        match: `${metrics.lineCount} lines`,
        severity: "medium",
        category: "metrics",
        description: `File exceeds ${maxFileLines} line threshold (${metrics.lineCount} lines)`,
        suggestion: "Split the file into smaller, focused modules.",
        fixable: false,
      });
    }

    if (metrics.complexityScore > maxComplexity) {
      findings.push({
        ruleId: "metrics-high-complexity",
        file: relativePath,
        line: 1,
        match: `complexity ${metrics.complexityScore.toFixed(2)}`,
        severity: "high",
        category: "metrics",
        description: `File complexity score ${metrics.complexityScore.toFixed(2)} exceeds threshold ${maxComplexity}`,
        suggestion: "Reduce nesting, extract functions, and simplify branching logic.",
        fixable: false,
      });
    }

    if (metrics.maxNestingDepth > maxNesting) {
      findings.push({
        ruleId: "metrics-deep-nesting",
        file: relativePath,
        line: 1,
        match: `nesting depth ${metrics.maxNestingDepth}`,
        severity: "medium",
        category: "metrics",
        description: `File max nesting depth ${metrics.maxNestingDepth} exceeds threshold ${maxNesting}`,
        suggestion: "Extract nested logic into named functions or guard clauses.",
        fixable: false,
      });
    }

    if (metrics.exportCount > maxExportsPerFile) {
      findings.push({
        ruleId: "metrics-high-exports",
        file: relativePath,
        line: 1,
        match: `${metrics.exportCount} exports`,
        severity: "medium",
        check: "modularity",
        category: "modularity",
        confidence: 0.85,
        description: `File has ${metrics.exportCount} exports, exceeding threshold of ${maxExportsPerFile}`,
        suggestion: "Split exports into smaller, more focused modules.",
        fixable: false,
      });
    }

    if (metrics.importCount > maxImportsPerFile) {
      findings.push({
        ruleId: "metrics-high-imports",
        file: relativePath,
        line: 1,
        match: `${metrics.importCount} imports`,
        severity: "medium",
        check: "modularity",
        category: "modularity",
        confidence: 0.85,
        description: `File has ${metrics.importCount} imports, exceeding threshold of ${maxImportsPerFile}`,
        suggestion: "Consider reducing dependencies or splitting the file.",
        fixable: false,
      });
    }

    if (metrics.commentToCodeRatio < 0.02 && metrics.complexityScore > maxComplexity) {
      findings.push({
        ruleId: "metrics-low-comments",
        file: relativePath,
        line: 1,
        match: `commentToCodeRatio ${metrics.commentToCodeRatio}`,
        severity: "low",
        check: "comment-quality",
        category: "comment-quality",
        confidence: 0.7,
        description: `Complex file (complexity ${metrics.complexityScore.toFixed(2)}) has very low comment ratio (${metrics.commentToCodeRatio})`,
        suggestion: "Add explanatory comments to complex logic.",
        fixable: false,
      });
    }

    if (metrics.commentToCodeRatio > 0.5) {
      findings.push({
        ruleId: "metrics-excessive-comments",
        file: relativePath,
        line: 1,
        match: `commentToCodeRatio ${metrics.commentToCodeRatio}`,
        severity: "low",
        check: "comment-quality",
        category: "comment-quality",
        confidence: 0.7,
        description: `File has excessive comment ratio (${metrics.commentToCodeRatio}) — more comments than code`,
        suggestion: "Review and prune redundant or narration-style comments.",
        fixable: false,
      });
    }
  }

  return { fileMetrics, findings };
}
