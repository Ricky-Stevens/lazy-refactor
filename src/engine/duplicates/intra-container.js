/**
 * Intra-structure duplication detection for the duplicate scanner.
 *
 * A SAME-FILE duplicate pair whose two windows are fully nested inside one
 * unbroken bracket container is repetition WITHIN a single data structure (array
 * rows, object literals, switch arms), not extractable copy-paste. Such a pair is
 * confidence-capped (not suppressed) so it never auto-feeds the fixer, while a low
 * minConfidence still surfaces it. Cross-file duplication never uses this path.
 */

const OPEN_BRACKETS = new Set(["(", "[", "{"]);
const CLOSE_BRACKETS = new Set([")", "]", "}"]);

// Confidence ceiling for an intra-structure pair — below the default minConfidence
// (0.5) and the bulk-/fix floor (0.8).
export const INTRA_CONTAINER_CAP = 0.45;

// The cap applies ONLY to data-like repetition. A same-file pair nested in one
// container can still be genuine, extractable copy-paste (duplicated methods, two
// pasted logic blocks) which must stay at full confidence. Distinguishing "data"
// needs BOTH scoring signals to agree, because structural ratio (control-flow
// density) alone scores straight-line assignment code as low as data — `const`/
// `=`/`+` aren't structural tokens. So we cap only when structural ratio is low
// AND token diversity is low; per scoring.js, diversity ~0.02–0.05 = repetitive
// data while ~0.15+ = varied logic, so pasted code (high diversity) is never capped.
export const INTRA_CONTAINER_MAX_STRUCTURAL = 0.2;
export const INTRA_CONTAINER_MAX_DIVERSITY = 0.15;

/**
 * True when tokens[fromIdx..toIdx) never close out of the bracket container that
 * encloses fromIdx (and one exists). Normalised tokens collapse strings/comments
 * and emit each bracket as its own token, so depth counting is exact.
 * @param {string[]} tokens - normalised token stream for the (single) file
 * @param {number} fromIdx
 * @param {number} toIdx
 * @returns {boolean}
 */
export function sharesEnclosingContainer(tokens, fromIdx, toIdx) {
  let enclosing = 0;
  for (let i = 0; i < fromIdx; i++) {
    if (OPEN_BRACKETS.has(tokens[i])) enclosing++;
    else if (CLOSE_BRACKETS.has(tokens[i])) enclosing--;
  }
  if (enclosing < 1) return false;
  let depth = enclosing;
  const end = Math.min(toIdx, tokens.length);
  for (let i = fromIdx; i < end; i++) {
    if (OPEN_BRACKETS.has(tokens[i])) depth++;
    else if (CLOSE_BRACKETS.has(tokens[i])) {
      depth--;
      if (depth < enclosing) return false;
    }
  }
  return true;
}
