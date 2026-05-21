/**
 * Finding mapper functions — transform raw engine output into the normalised
 * finding shape used by the MCP layer.
 */

export function mapDupe(f) {
  return {
    check: f.check,
    severity: "medium",
    category: "duplication",
    locations: [{ file: f.fileA, startLine: f.startLineA, endLine: f.endLineA }],
    description: `Duplicate code block between ${f.fileA} and ${f.fileB}`,
    similarity: f.similarity,
    tokenCount: f.tokenCount,
    fileB: f.fileB,
    startLineB: f.startLineB,
    endLineB: f.endLineB,
    suggestion: "Extract shared logic into a reusable function or module.",
    fixable: true,
    confidence: f.similarity,
    language: f.language ?? "common",
  };
}

export function mapDeadExport(f, resolvedPath) {
  return {
    check: f.check,
    severity: "low",
    category: "dead-code",
    locations: [{ file: f.file.replace(`${resolvedPath}/`, ""), startLine: f.exportLine + 1 }],
    description: `Exported symbol '${f.symbol}' appears unused`,
    symbol: f.symbol,
    suggestion: "Remove the export or verify it is consumed externally.",
    fixable: true,
    confidence: f.confidence,
    language: f.language ?? "common",
  };
}

export function mapUnusedDep(f) {
  return {
    check: f.check,
    severity: "low",
    category: "dead-code",
    locations: [],
    description: `Dependency '${f.dep}' declared in ${f.manifest} manifest but not referenced in source`,
    dep: f.dep,
    suggestion: "Remove the dependency or verify it is used via dynamic require.",
    fixable: true,
    confidence: 0.7,
    language: f.language ?? "common",
  };
}

export function mapUnusedImport(f, resolvedPath) {
  return {
    check: f.check,
    severity: "low",
    category: "dead-code",
    locations: [{ file: f.file.replace(`${resolvedPath}/`, ""), startLine: f.importLine + 1 }],
    description: `Import '${f.symbol}' is never used`,
    symbol: f.symbol,
    suggestion: "Remove the unused import.",
    fixable: true,
    confidence: 0.85,
    language: f.language ?? "common",
  };
}

export function mapMetric(f) {
  return {
    check: f.ruleId,
    severity: f.severity,
    category: f.category,
    locations: [{ file: f.file, startLine: f.line }],
    description: f.description,
    suggestion: f.suggestion,
    fixable: f.fixable,
    confidence: 0.95,
    language: f.language ?? "common",
  };
}

export function mapPattern(f) {
  return {
    check: f.ruleId,
    severity: f.severity,
    category: f.category,
    locations: [{ file: f.file, startLine: f.line }],
    description: f.description,
    suggestion: f.suggestion,
    fixable: f.fixable,
    confidence: 0.9,
    language: f.language ?? "common",
  };
}

export function mapInconsistent(f, resolvedPath) {
  return {
    check: f.check ?? "inconsistent-pattern",
    severity: f.severity ?? "low",
    category: f.category ?? "consistency",
    locations:
      f.locations ??
      (f.file ? [{ file: f.file.replace(`${resolvedPath}/`, ""), startLine: f.line ?? 1 }] : []),
    description: f.description,
    suggestion:
      f.suggestion ?? "Align with the predominant pattern used elsewhere in the codebase.",
    fixable: f.fixable ?? true,
    confidence: f.confidence ?? 0.75,
    language: f.language ?? "common",
  };
}

export function mapOverEngineering(f, resolvedPath) {
  return {
    check: f.check ?? "over-engineering",
    severity: f.severity ?? "low",
    category: f.category ?? "complexity",
    locations:
      f.locations ??
      (f.file ? [{ file: f.file.replace(`${resolvedPath}/`, ""), startLine: f.line ?? 1 }] : []),
    description: f.description,
    suggestion: f.suggestion ?? "Simplify to the minimum viable abstraction.",
    fixable: f.fixable ?? true,
    confidence: f.confidence ?? 0.7,
    language: f.language ?? "common",
  };
}
