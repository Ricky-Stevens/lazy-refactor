const SEVERITY_WEIGHTS = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export function scoreFinding(finding) {
  const severityWeight = SEVERITY_WEIGHTS[finding.severity] ?? 1;
  // confidence defaults to 1 when absent
  const confidence = typeof finding.confidence === "number" ? finding.confidence : 1;
  const score = severityWeight * confidence;
  return { ...finding, score };
}

export function scoreFindings(findings) {
  return findings.map(scoreFinding).sort((a, b) => b.score - a.score);
}
