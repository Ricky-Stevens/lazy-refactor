import { basename } from "node:path";
import { collectFiles, readFilesBatched } from "./files.js";
import { computeFileMetrics } from "./metrics-compute.js";

const GRAB_BAG_STRONG_RE = /^(?:helpers?|utils?|misc|lib|tools|functions|methods)\./i;
const GRAB_BAG_WEAK_RE = /^(?:common|shared)\./i;

export { computeFileMetrics, isPythonFile } from "./metrics-compute.js";

/**
 * Build threshold-violation findings for a single file's metrics.
 * @param {object} metrics  Result of computeFileMetrics
 * @param {string} file     Relative file path
 * @param {object} thresholds
 * @returns {Array}
 */
function buildThresholdFindings(metrics, file, thresholds) {
  const { maxFileLines, maxComplexity, maxNesting, maxExportsPerFile, maxImportsPerFile } =
    thresholds;
  const result = [];

  if (metrics.lineCount > maxFileLines) {
    result.push({
      ruleId: "metrics-long-file",
      file,
      line: 1,
      match: `${metrics.lineCount} lines`,
      severity: "medium",
      category: "metrics",
      description: `File exceeds ${maxFileLines} line threshold (${metrics.lineCount} lines)`,
      suggestion: "Split the file into smaller, focused modules.",
      fixable: true,
    });
  }

  if (metrics.complexityScore > maxComplexity) {
    result.push({
      ruleId: "metrics-high-complexity",
      file,
      line: 1,
      match: `complexity ${metrics.complexityScore.toFixed(2)}`,
      severity: "high",
      category: "metrics",
      description: `File complexity score ${metrics.complexityScore.toFixed(2)} exceeds threshold ${maxComplexity}`,
      suggestion: "Reduce nesting, extract functions, and simplify branching logic.",
      fixable: true,
    });
  }

  if (metrics.maxNestingDepth > maxNesting) {
    result.push({
      ruleId: "metrics-deep-nesting",
      file,
      line: 1,
      match: `nesting depth ${metrics.maxNestingDepth}`,
      severity: "medium",
      category: "metrics",
      description: `File max nesting depth ${metrics.maxNestingDepth} exceeds threshold ${maxNesting}`,
      suggestion: "Extract nested logic into named functions or guard clauses.",
      fixable: true,
    });
  }

  if (metrics.exportCount > maxExportsPerFile) {
    result.push({
      ruleId: "metrics-high-exports",
      file,
      line: 1,
      match: `${metrics.exportCount} exports`,
      severity: "medium",
      check: "modularity",
      category: "modularity",
      confidence: 0.85,
      description: `File has ${metrics.exportCount} exports, exceeding threshold of ${maxExportsPerFile}`,
      suggestion: "Split exports into smaller, more focused modules.",
      fixable: true,
    });
  }

  if (metrics.importCount > maxImportsPerFile) {
    result.push({
      ruleId: "metrics-high-imports",
      file,
      line: 1,
      match: `${metrics.importCount} imports`,
      severity: "medium",
      check: "modularity",
      category: "modularity",
      confidence: 0.85,
      description: `File has ${metrics.importCount} imports, exceeding threshold of ${maxImportsPerFile}`,
      suggestion: "Consider reducing dependencies or splitting the file.",
      fixable: true,
    });
  }

  if (metrics.commentToCodeRatio < 0.02 && metrics.complexityScore > maxComplexity) {
    result.push({
      ruleId: "metrics-low-comments",
      file,
      line: 1,
      match: `commentToCodeRatio ${metrics.commentToCodeRatio}`,
      severity: "low",
      check: "comment-quality",
      category: "comment-quality",
      confidence: 0.7,
      description: `Complex file (complexity ${metrics.complexityScore.toFixed(2)}) has very low comment ratio (${metrics.commentToCodeRatio})`,
      suggestion: "Add explanatory comments to complex logic.",
      fixable: true,
    });
  }

  if (metrics.commentToCodeRatio > 0.5) {
    result.push({
      ruleId: "metrics-excessive-comments",
      file,
      line: 1,
      match: `commentToCodeRatio ${metrics.commentToCodeRatio}`,
      severity: "low",
      check: "comment-quality",
      category: "comment-quality",
      confidence: 0.7,
      description: `File has excessive comment ratio (${metrics.commentToCodeRatio}) — more comments than code`,
      suggestion: "Review and prune redundant or narration-style comments.",
      fixable: true,
    });
  }

  const fileName = basename(file);
  const isStrongGrabBag = GRAB_BAG_STRONG_RE.test(fileName);
  const isWeakGrabBag = GRAB_BAG_WEAK_RE.test(fileName);
  if (isStrongGrabBag || isWeakGrabBag) {
    const isTooBig = metrics.lineCount > 150;
    const isTooScattered = metrics.exportCount > 5;
    const shouldFlag = isStrongGrabBag ? isTooBig || isTooScattered : isTooBig && isTooScattered;
    if (shouldFlag) {
      result.push({
        ruleId: "metrics-grab-bag",
        file,
        line: 1,
        match: `${fileName}: ${metrics.lineCount} lines, ${metrics.exportCount} exports`,
        severity: "medium",
        category: "modularity",
        confidence: 0.8,
        description: `'${fileName}' has a generic name with ${metrics.lineCount} lines and ${metrics.exportCount} exports — likely a grab-bag of unrelated concerns`,
        suggestion: "Split into focused modules named after their specific responsibility.",
        fixable: true,
      });
    }
  }

  return result;
}

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
 * @returns {Promise<object>} Object with `fileMetrics` array and `findings` array
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

  const contents = await readFilesBatched(filePaths);
  const fileMetrics = [];
  const findings = [];
  const thresholds = {
    maxFileLines,
    maxComplexity,
    maxNesting,
    maxExportsPerFile,
    maxImportsPerFile,
  };

  for (const [filePath, content] of contents) {
    const metrics = computeFileMetrics(content, filePath);
    const relativePath = filePath.startsWith(path)
      ? filePath.slice(path.length).replace(/^\//, "")
      : filePath;

    fileMetrics.push({ file: relativePath, ...metrics });
    findings.push(...buildThresholdFindings(metrics, relativePath, thresholds));
  }

  return { fileMetrics, findings };
}
