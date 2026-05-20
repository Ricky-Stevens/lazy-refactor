/**
 * Finding scorer and prioritiser.
 *
 * Score formula: severityWeight * confidence * (1 / riskValue)
 *
 * Severity weights: critical=4, high=3, medium=2, low=1
 * Risk values:      low=1, medium=2, high=3
 * Confidence:       0.0–1.0 float on the finding
 */

const SEVERITY_WEIGHTS = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const RISK_VALUES = {
  low: 1,
  medium: 2,
  high: 3,
};

/**
 * Score a single finding. Returns the finding with a `score` field added.
 *
 * @param {object} finding
 * @returns {object}
 */
export function scoreFinding(finding) {
  const severityWeight = SEVERITY_WEIGHTS[finding.severity] ?? 1;
  const riskValue = RISK_VALUES[finding.risk] ?? 1;
  const confidence = typeof finding.confidence === "number" ? finding.confidence : 1;
  const score = severityWeight * confidence * (1 / riskValue);
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

/**
 * Group findings by severity into { critical, high, medium, low }.
 *
 * @param {object[]} findings
 * @returns {{ critical: object[], high: object[], medium: object[], low: object[] }}
 */
export function groupBySeverity(findings) {
  const groups = { critical: [], high: [], medium: [], low: [] };
  for (const finding of findings) {
    const key = finding.severity;
    if (key in groups) {
      groups[key].push(finding);
    }
  }
  return groups;
}
