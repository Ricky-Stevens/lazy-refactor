/**
 * User-curated ignore list.
 *
 * The `ignore` key in `.lazy-refactor.json` is a list of project-relative files
 * and directories a user has flagged to be permanently skipped by scans (seed
 * scripts, fixtures, generated helpers, etc.). It is deliberately SEPARATE from
 * the default `exclude` noise globs (vendored/minified artifacts) so the curated
 * list stays clean and reviewable, and from `.gitignore` (which serves a
 * different purpose — what git tracks). This module turns those entries into
 * glob patterns the existing `collectFiles`/`globToRegex` exclude pipeline can
 * consume; matching itself is NOT reimplemented here.
 */

// Glob metacharacters: their presence means an entry is already a pattern the
// user authored deliberately, so it passes through verbatim. A `(` is NOT a
// metacharacter for our matcher (globToRegex treats parens literally), so it
// must not force passthrough — otherwise a plain path containing parens would
// skip directory expansion.
const GLOB_META = /[*?{}[\]]/;

/**
 * Normalize a single raw ignore entry: trim, strip a leading `./` and trailing
 * slashes. Returns "" for blanks, comments, and bare `.`/`./` so callers can drop
 * them. Tolerant of `#` comments so a hand-edited array reads the same as a file.
 * @param {string} raw
 * @returns {string}
 */
export function normalizeIgnoreEntry(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return "";
  const cleaned = trimmed.replace(/^\.\//, "").replace(/\/+$/, "");
  return cleaned === "." ? "" : cleaned;
}

/**
 * Expand user ignore-list entries into glob patterns for `collectFiles`' exclude
 * pipeline. A PLAIN path (no glob metachars) is expanded to TWO patterns:
 *   "scripts/seed"  ->  "scripts/seed"  +  "scripts/seed/**"
 * so it matches whether it names a FILE (the literal, tested against rel/basename
 * by `isExcluded`) or a DIRECTORY (its contents, via `/**`). This is what makes
 * "ignore this directory" work without the user having to know glob syntax.
 * Entries that already contain glob syntax pass through unchanged.
 * @param {string[]} entries
 * @returns {string[]} de-duplicated glob patterns (empty array for non-arrays)
 */
export function expandIgnorePatterns(entries) {
  if (!Array.isArray(entries)) return [];
  const out = new Set();
  for (const raw of entries) {
    const entry = normalizeIgnoreEntry(raw);
    if (entry === "") continue;
    out.add(entry);
    if (!GLOB_META.test(entry)) out.add(`${entry}/**`);
  }
  return [...out];
}
