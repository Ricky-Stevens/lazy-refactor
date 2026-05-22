import { extname } from "node:path";

export function isPythonFile(filePath) {
  return extname(filePath).toLowerCase() === ".py";
}

/**
 * Remove line comments and string literals to avoid matching keywords inside them.
 * @param {string} trimmed  Already-trimStart'd line
 * @param {boolean} python
 * @returns {string}
 */
function stripLine(trimmed, python) {
  let s = trimmed.replace(/\/\/.*$/, "");
  if (python) s = s.replace(/#.*$/, "");
  s = s.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
  return s;
}

/**
 * Count branch points on a single stripped line.
 * `else if` counts as 1 (the `if`), not 2.
 * `?.` and `??` are excluded from ternary counting.
 * @param {string} stripped
 * @returns {number}
 */
function countBranchPoints(stripped) {
  const ifCount = (stripped.match(/\bif\b/g) ?? []).length;
  const elseCount = (stripped.match(/\belse\b/g) ?? []).length;
  const elseIfCount = (stripped.match(/\belse\s+if\b/g) ?? []).length;
  let count = ifCount + (elseCount - elseIfCount);

  for (const pat of [/\bswitch\b/g, /\bfor\b/g, /\bwhile\b/g, /\bdo\b/g, /&&/g, /\|\|/g]) {
    count += (stripped.match(pat) ?? []).length;
  }

  const q = (stripped.match(/\?/g) ?? []).length;
  const qDot = (stripped.match(/\?\./g) ?? []).length;
  const qq = (stripped.match(/\?\?/g) ?? []).length;
  // `??` contains two `?` chars; subtract both plus the extra from `?.`
  count += q - qDot - qq * 2;

  return count;
}

/**
 * Count exports and imports for a single stripped line.
 * Go has no `export` keyword — uppercase func/type/var/const declarations are exported.
 * Go import blocks need per-line counting rather than keyword matching.
 * @param {string} stripped
 * @param {boolean} isGo
 * @returns {{ exports: number, imports: number }}
 */
function countExportsImports(stripped, isGo) {
  if (isGo) {
    const exports = /\b(?:func|type|var|const)\s+[A-Z]/.test(stripped) ? 1 : 0;
    let imports = 0;
    if (/^\s*import\s+"/.test(stripped)) {
      imports = 1;
    } else if (
      /^\s*(?:\.\s+|[a-zA-Z_]\w*\s+)?"[^"]*"/.test(stripped) &&
      !/\bimport\s*\(/.test(stripped) &&
      !/^\s*import\b/.test(stripped)
    ) {
      imports = 1;
    }
    return { exports, imports };
  }
  return {
    exports: /\bexport\b/.test(stripped) ? 1 : 0,
    imports: /\bimport\b/.test(stripped) || /\brequire\s*\(/.test(stripped) ? 1 : 0,
  };
}

/**
 * Update brace-based nesting depth for one line.
 * Heuristic: a line ending with `{` opens a block; a line starting with `}` closes one.
 * This avoids inflating depth for object literals and destructuring.
 * @param {string} stripped
 * @param {number} depth
 * @returns {number} updated depth
 */
function updateBraceNesting(stripped, depth) {
  let d = depth;
  if (/^\s*\}/.test(stripped) && d > 0) d--;
  if (stripped.trimEnd().endsWith("{")) d++;
  return d;
}

/**
 * Update indent-stack-based nesting depth for one Python line.
 * @param {string} line       Raw (un-trimmed) line
 * @param {string} trimmed    trimStart'd line
 * @param {number[]} stack    Mutable indent stack (caller owns it)
 * @returns {number} current depth after processing this line
 */
function updateIndentNesting(line, trimmed, stack) {
  if (trimmed === "") return stack.length - 1;
  const indent = line.length - trimmed.length;
  const top = stack[stack.length - 1];
  if (indent > top) {
    stack.push(indent);
  } else {
    while (stack.length > 1 && stack[stack.length - 1] > indent) stack.pop();
    if (stack[stack.length - 1] !== indent) stack.push(indent);
  }
  return stack.length - 1;
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
  const python = isPythonFile(filePath);
  const isGo = filePath.endsWith(".go");

  let maxNestingDepth = 0;
  let branchPointCount = 0;
  let commentLines = 0;
  let codeLines = 0;
  let exportCount = 0;
  let importCount = 0;
  let nestingDepth = 0;
  const indentStack = [0];

  for (const line of lines) {
    const trimmed = line.trimStart();

    const isComment =
      trimmed.startsWith("//") ||
      (python && trimmed.startsWith("#")) ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("*/") ||
      trimmed === "";

    if (trimmed !== "") {
      if (isComment) commentLines++;
      else codeLines++;
    }

    const stripped = stripLine(trimmed, python);

    const { exports, imports } = countExportsImports(stripped, isGo);
    exportCount += exports;
    importCount += imports;

    branchPointCount += countBranchPoints(stripped);

    if (python) {
      const depth = updateIndentNesting(line, trimmed, indentStack);
      if (depth > maxNestingDepth) maxNestingDepth = depth;
    } else {
      nestingDepth = updateBraceNesting(stripped, nestingDepth);
      if (nestingDepth > maxNestingDepth) maxNestingDepth = nestingDepth;
    }
  }

  // Raw float — callers compare against fractional thresholds; rounding would cause boundary errors.
  const commentToCodeRatio = codeLines === 0 ? 0 : commentLines / codeLines;
  const complexityScore = maxNestingDepth * 3 + branchPointCount * 2 + lines.length / 50;

  return {
    lineCount: lines.length,
    maxNestingDepth,
    branchPointCount,
    commentToCodeRatio,
    exportCount,
    importCount,
    complexityScore,
  };
}
