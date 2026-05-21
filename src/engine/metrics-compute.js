import { extname } from "node:path";

/**
 * Determine whether a file is a Python file by extension.
 * This is the ONE permitted language-specific branch.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isPythonFile(filePath) {
  return extname(filePath).toLowerCase() === ".py";
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
  const lines = content.split("\n");
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
      trimmed.startsWith("//") ||
      (python && trimmed.startsWith("#")) ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("*/") ||
      trimmed === "";

    if (trimmed === "") {
      // blank lines count neither as comment nor code
    } else if (isComment) {
      commentLines++;
    } else {
      codeLines++;
    }

    // ----------------------------------------------------------------
    // Strip strings and comments before counting to reduce false positives.
    // The stripped line is used for export/import detection, branch counting,
    // and (for non-Python) nesting tracking.
    // ----------------------------------------------------------------
    let strippedLine = trimmed.replace(/\/\/.*$/, ""); // remove line comment
    if (python) strippedLine = strippedLine.replace(/#.*$/, ""); // remove Python comment
    strippedLine = strippedLine
      .replace(/"(?:[^"\\]|\\.)*"/g, '""') // remove double-quoted strings
      .replace(/'(?:[^'\\]|\\.)*'/g, "''"); // remove single-quoted strings

    // ----------------------------------------------------------------
    // Export / import counting. Run on the stripped line so keywords
    // inside comments or strings don't count.
    //
    // Go has no `export` keyword — exported identifiers start with an
    // uppercase letter. We approximate by counting func/type/var/const
    // declarations with an uppercase name. For imports, we count lines
    // inside `import (...)` blocks or standalone `import "..."` lines
    // rather than just the `import` keyword occurrence.
    // ----------------------------------------------------------------
    const isGo = filePath.endsWith(".go");
    if (isGo) {
      if (/\b(?:func|type|var|const)\s+[A-Z]/.test(strippedLine)) exportCount++;
      // Count individual import specs: `import "fmt"` or a line inside `import (...)`
      // that looks like `"pkg"` or `. "pkg"` or `alias "pkg"`.
      // We do NOT count the bare `import (` or `import "..."` keyword line twice —
      // standalone `import "x"` matches the quoted-string pattern below.
      if (/^\s*import\s+"/.test(strippedLine)) {
        importCount++;
      } else if (
        /^\s*(?:\.\s+|[a-zA-Z_]\w*\s+)?"[^"]*"/.test(strippedLine) &&
        !/\bimport\s*\(/.test(strippedLine) &&
        !/^\s*import\b/.test(strippedLine)
      ) {
        // A line inside an import block: `  "fmt"` or `  alias "pkg"`
        importCount++;
      }
    } else {
      if (/\bexport\b/.test(strippedLine)) exportCount++;
      if (/\bimport\b/.test(strippedLine) || /\brequire\s*\(/.test(strippedLine)) importCount++;
    }

    // ----------------------------------------------------------------
    // Branch point counting
    // Counts: if, else, switch, for, while, do, ternary (?), &&, ||
    // Special cases:
    //  - `else if` counts as 1 branch point (the `if`), not 2.
    //  - `?.` (optional chaining) and `??` (nullish coalescing) are NOT
    //    ternary operators and must not be counted.
    // ----------------------------------------------------------------
    const ifCount = (strippedLine.match(/\bif\b/g) ?? []).length;
    const elseCount = (strippedLine.match(/\belse\b/g) ?? []).length;
    const elseIfCount = (strippedLine.match(/\belse\s+if\b/g) ?? []).length;
    // Each `else if` already contributes 1 via the if count above, so we
    // subtract it from the else count to avoid double-counting.
    branchPointCount += ifCount + (elseCount - elseIfCount);

    const otherBranchPatterns = [
      /\bswitch\b/g,
      /\bfor\b/g,
      /\bwhile\b/g,
      /\bdo\b/g,
      /&&/g,
      /\|\|/g,
    ];
    for (const bp of otherBranchPatterns) {
      const matches = strippedLine.match(bp);
      if (matches) branchPointCount += matches.length;
    }

    // Ternary `?` count: every `?` minus the `?.` and `??` occurrences,
    // which are unrelated operators.
    const questionMarks = (strippedLine.match(/\?/g) ?? []).length;
    const optionalChains = (strippedLine.match(/\?\./g) ?? []).length;
    const nullishCoalesce = (strippedLine.match(/\?\?/g) ?? []).length;
    // `??` contains two `?` chars but is one operator, so it inflates the
    // raw count by 2. `?.` contains one `?` char and inflates by 1.
    branchPointCount += questionMarks - optionalChains - nullishCoalesce * 2;

    // ----------------------------------------------------------------
    // Nesting depth
    // ----------------------------------------------------------------
    if (python) {
      // Indent-based nesting for Python
      if (trimmed !== "") {
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
      // Brace-based nesting for C-family languages (JS, TS, Go, Java, C#).
      //
      // Counting every `{` and `}` inflates the depth for object literals,
      // destructuring patterns, and JSX expression containers (e.g.
      // `const x = { a: 1 }` is one statement, not a nested block).
      //
      // Heuristic: a line whose stripped form ends with `{` is a block
      // opener (function body, if/for/while/switch, class, etc.) and a
      // line whose stripped form starts with `}` is a block closer. This
      // misses some edge cases (single-line `} else {`) but is a much
      // closer approximation of structural nesting than raw brace
      // counting and never confuses object literals for blocks.
      const trimmedEnd = strippedLine.trimEnd();

      // A leading `}` closes the enclosing block. `} else {` both closes
      // and opens, so we still process the trailing `{` below.
      if (/^\s*\}/.test(strippedLine)) {
        if (nestingDepth > 0) nestingDepth--;
      }

      if (trimmedEnd.endsWith("{")) {
        nestingDepth++;
        if (nestingDepth > maxNestingDepth) maxNestingDepth = nestingDepth;
      }
    }
  }

  // Raw float ratio — callers compare against fractional thresholds so
  // rounding here would introduce boundary inconsistencies.
  const commentToCodeRatio = codeLines === 0 ? 0 : commentLines / codeLines;

  // complexityScore = nestingDepth*3 + branchPoints*2 + lineCount/50
  const complexityScore = maxNestingDepth * 3 + branchPointCount * 2 + lineCount / 50;

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
