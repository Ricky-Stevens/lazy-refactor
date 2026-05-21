/**
 * Finding scorer and prioritiser.
 *
 * Score formula: severityWeight * confidence
 *
 * Severity weights: critical=4, high=3, medium=2, low=1
 * Confidence:       0.0–1.0 float on the finding (defaults to 1 if absent)
 */

const SEVERITY_WEIGHTS = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Score a single finding. Returns the finding with a `score` field added.
 *
 * @param {object} finding
 * @returns {object}
 */
export function scoreFinding(finding) {
  const severityWeight = SEVERITY_WEIGHTS[finding.severity] ?? 1;
  const confidence = typeof finding.confidence === "number" ? finding.confidence : 1;
  const score = severityWeight * confidence;
  return { ...finding, score };
}

/**
 * Score all findings and return them sorted by score descending.
 *
 * @param {object[]} findings
 * @returns {object[]}
 */
export function scoreFindings(findings) {
  return findings.map(scoreFinding).sort((a, b) => b.score - a.score);
}
