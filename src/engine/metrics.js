import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

/** Map language name -> file extensions */
const LANGUAGE_EXTENSIONS = {
  typescript: ['.ts', '.tsx', '.js', '.jsx'],
  javascript: ['.js', '.jsx'],
  go: ['.go'],
  python: ['.py'],
  csharp: ['.cs'],
  java: ['.java'],
  common: ['.ts', '.tsx', '.js', '.jsx', '.go', '.py', '.cs', '.java'],
};

/** All recognised source extensions (union of all language sets) */
const ALL_SOURCE_EXTENSIONS = new Set(
  Object.values(LANGUAGE_EXTENSIONS).flat()
);

/**
 * Determine whether a file is a Python file by extension.
 * This is the ONE permitted language-specific branch.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isPythonFile(filePath) {
  return extname(filePath).toLowerCase() === '.py';
}

/**
 * Compute per-file metrics from file content.
 *
 * @param {string} content    Raw file text
 * @param {string} filePath   Used for language detection
 * @returns {{
 *   lineCount: number,
 *   maxNestingDepth: number,
 *   branchPointCount: number,
 *   commentToCodeRatio: number,
 *   exportCount: number,
 *   importCount: number,
 *   complexityScore: number
 * }}
 */
export function computeFileMetrics(content, filePath) {
  const lines = content.split('\n');
  const lineCount = lines.length;

  const python = isPythonFile(filePath);

  let maxNestingDepth = 0;
  let branchPointCount = 0;
  let commentLines = 0;
  let codeLines = 0;
  let exportCount = 0;
  let importCount = 0;

  // Brace-based nesting state
  let nestingDepth = 0;

  // Python indent-based nesting state
  const indentStack = [0]; // stack of indentation levels

  for (const line of lines) {
    const trimmed = line.trimStart();

    // ----------------------------------------------------------------
    // Comment detection
    // ----------------------------------------------------------------
    const isComment =
      trimmed.startsWith('//') ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('*/') ||
      trimmed === '';

    if (trimmed === '') {
      // blank lines count neither as comment nor code
    } else if (isComment) {
      commentLines++;
    } else {
      codeLines++;
    }

    // ----------------------------------------------------------------
    // Export / import counting (language-agnostic patterns)
    // ----------------------------------------------------------------
    if (/\bexport\b/.test(trimmed)) exportCount++;
    if (/\bimport\b/.test(trimmed) || /\brequire\s*\(/.test(trimmed)) importCount++;

    // ----------------------------------------------------------------
    // Branch point counting
    // Counts: if, else, switch, for, while, ternary (?), &&, ||
    // ----------------------------------------------------------------
    // Strip strings and comments before counting to reduce false positives
    const strippedLine = trimmed
      .replace(/\/\/.*$/, '')     // remove line comment
      .replace(/#.*$/, '')        // remove Python comment
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')  // remove double-quoted strings
      .replace(/'(?:[^'\\]|\\.)*'/g, "''"); // remove single-quoted strings

    // Count individual branch constructs; each occurrence = +1 branch point
    const branchPatterns = [
      /\bif\b/g,
      /\belse\b/g,
      /\bswitch\b/g,
      /\bfor\b/g,
      /\bwhile\b/g,
      /\bdo\b/g,
      /\?/g,           // ternary
      /&&/g,
      /\|\|/g,
    ];
    for (const bp of branchPatterns) {
      const matches = strippedLine.match(bp);
      if (matches) branchPointCount += matches.length;
    }

    // ----------------------------------------------------------------
    // Nesting depth
    // ----------------------------------------------------------------
    if (python) {
      // Indent-based nesting for Python
      if (trimmed !== '') {
        const indent = line.length - line.trimStart().length;
        const currentIndent = indentStack[indentStack.length - 1];
        if (indent > currentIndent) {
          indentStack.push(indent);
        } else {
          while (indentStack.length > 1 && indentStack[indentStack.length - 1] > indent) {
            indentStack.pop();
          }
          if (indentStack[indentStack.length - 1] !== indent) {
            indentStack.push(indent);
          }
        }
        const depth = indentStack.length - 1; // depth 0 = top-level
        if (depth > maxNestingDepth) maxNestingDepth = depth;
      }
    } else {
      // Brace-based nesting for C-family languages (JS, TS, Go, Java, C#)
      // Count braces on this line, updating running depth
      for (const ch of strippedLine) {
        if (ch === '{') {
          nestingDepth++;
          if (nestingDepth > maxNestingDepth) maxNestingDepth = nestingDepth;
        } else if (ch === '}') {
          if (nestingDepth > 0) nestingDepth--;
        }
      }
    }
  }

  const totalSignificantLines = commentLines + codeLines;
  const commentToCodeRatio =
    codeLines === 0
      ? 0
      : Math.round((commentLines / codeLines) * 100) / 100;

  // complexityScore = nestingDepth*3 + branchPoints*2 + lineCount/50
  const complexityScore =
    maxNestingDepth * 3 + branchPointCount * 2 + lineCount / 50;

  return {
    lineCount,
    maxNestingDepth,
    branchPointCount,
    commentToCodeRatio,
    exportCount,
    importCount,
    complexityScore,
  };
}

/**
 * Recursively find all source files under a directory matching requested languages.
 * @param {string} dirPath
 * @param {Set<string>} allowedExtensions
 * @returns {Promise<string[]>}
 */
async function findSourceFiles(dirPath, allowedExtensions) {
  const results = [];
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    // Unreadable directory — skip silently
    return results;
  }
  for (const entry of entries) {
    // Skip common non-source directories
    if (
      entry.isDirectory() &&
      (entry.name === 'node_modules' ||
        entry.name === 'vendor' ||
        entry.name === '.git')
    ) {
      continue;
    }
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const sub = await findSourceFiles(fullPath, allowedExtensions);
      results.push(...sub);
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (allowedExtensions.has(ext)) {
        results.push(fullPath);
      }
    }
  }
  return results;
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
 *   languages?: string[]
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
  } = options;

  // Build the set of allowed extensions
  let allowedExtensions;
  if (languages.length === 0) {
    allowedExtensions = ALL_SOURCE_EXTENSIONS;
  } else {
    allowedExtensions = new Set(
      languages.flatMap((lang) => LANGUAGE_EXTENSIONS[lang] ?? [])
    );
  }

  const filePaths = await findSourceFiles(path, allowedExtensions);

  const fileMetrics = [];
  const findings = [];

  for (const filePath of filePaths) {
    let content;
    try {
      content = await readFile(filePath, 'utf8');
    } catch {
      // Unreadable file — skip
      continue;
    }

    const metrics = computeFileMetrics(content, filePath);
    const relativePath = filePath.startsWith(path)
      ? filePath.slice(path.length).replace(/^\//, '')
      : filePath;

    fileMetrics.push({ file: relativePath, ...metrics });

    // Emit threshold findings
    if (metrics.lineCount > maxFileLines) {
      findings.push({
        ruleId: 'metrics-long-file',
        file: relativePath,
        line: 1,
        match: `${metrics.lineCount} lines`,
        severity: 'medium',
        category: 'metrics',
        description: `File exceeds ${maxFileLines} line threshold (${metrics.lineCount} lines)`,
        suggestion: 'Split the file into smaller, focused modules.',
        fixable: false,
      });
    }

    if (metrics.complexityScore > maxComplexity) {
      findings.push({
        ruleId: 'metrics-high-complexity',
        file: relativePath,
        line: 1,
        match: `complexity ${metrics.complexityScore.toFixed(2)}`,
        severity: 'high',
        category: 'metrics',
        description: `File complexity score ${metrics.complexityScore.toFixed(2)} exceeds threshold ${maxComplexity}`,
        suggestion: 'Reduce nesting, extract functions, and simplify branching logic.',
        fixable: false,
      });
    }

    if (metrics.maxNestingDepth > maxNesting) {
      findings.push({
        ruleId: 'metrics-deep-nesting',
        file: relativePath,
        line: 1,
        match: `nesting depth ${metrics.maxNestingDepth}`,
        severity: 'medium',
        category: 'metrics',
        description: `File max nesting depth ${metrics.maxNestingDepth} exceeds threshold ${maxNesting}`,
        suggestion: 'Extract nested logic into named functions or guard clauses.',
        fixable: false,
      });
    }

    if (metrics.exportCount > maxExportsPerFile) {
      findings.push({
        ruleId: 'metrics-high-exports',
        file: relativePath,
        line: 1,
        match: `${metrics.exportCount} exports`,
        severity: 'medium',
        check: 'modularity',
        confidence: 0.85,
        description: `File has ${metrics.exportCount} exports, exceeding threshold of ${maxExportsPerFile}`,
        suggestion: 'Split exports into smaller, more focused modules.',
        fixable: false,
      });
    }

    if (metrics.importCount > maxImportsPerFile) {
      findings.push({
        ruleId: 'metrics-high-imports',
        file: relativePath,
        line: 1,
        match: `${metrics.importCount} imports`,
        severity: 'medium',
        check: 'modularity',
        confidence: 0.85,
        description: `File has ${metrics.importCount} imports, exceeding threshold of ${maxImportsPerFile}`,
        suggestion: 'Consider reducing dependencies or splitting the file.',
        fixable: false,
      });
    }

    if (metrics.commentToCodeRatio < 0.02 && metrics.complexityScore > 15) {
      findings.push({
        ruleId: 'metrics-low-comments',
        file: relativePath,
        line: 1,
        match: `commentToCodeRatio ${metrics.commentToCodeRatio}`,
        severity: 'low',
        check: 'comment-quality',
        confidence: 0.7,
        description: `Complex file (complexity ${metrics.complexityScore.toFixed(2)}) has very low comment ratio (${metrics.commentToCodeRatio})`,
        suggestion: 'Add explanatory comments to complex logic.',
        fixable: false,
      });
    }

    if (metrics.commentToCodeRatio > 0.5) {
      findings.push({
        ruleId: 'metrics-excessive-comments',
        file: relativePath,
        line: 1,
        match: `commentToCodeRatio ${metrics.commentToCodeRatio}`,
        severity: 'low',
        check: 'comment-quality',
        confidence: 0.7,
        description: `File has excessive comment ratio (${metrics.commentToCodeRatio}) — more comments than code`,
        suggestion: 'Review and prune redundant or narration-style comments.',
        fixable: false,
      });
    }
  }

  return { fileMetrics, findings };
}
