/**
 * Small, dependency-free text helpers for TS/JS import/export parsing.
 * Kept separate so both the unused-import scanner and the dead-code import
 * extractor share one implementation (and one set of tests).
 */

/**
 * Strip a leading inline `type` modifier from a single import/export specifier.
 * Modern TS writes `import { type Foo, Bar }` (Biome/ESLint auto-fix to this),
 * where `type` is a modifier, not part of the name. Without stripping it the
 * symbol parses as the literal `"type Foo"`, which never matches real usage —
 * the dominant source of unused-import false positives.
 *
 * Only strips when `type` is followed by whitespace + more text, so a symbol
 * literally named `type` (e.g. `import { type } from './x'`) is left intact.
 *
 * @param {string} name - a single specifier, already split from its alias
 * @returns {string}
 */
export function stripTypeModifier(name) {
  return name.replace(/^type\s+/, "");
}

/**
 * Blank out line comments (double-slash) and C-style block comments while preserving
 * line count and offsets, so line numbers reported against the result stay accurate.
 * Block comments become runs of spaces (newlines kept); line comments are cut to
 * end of line. Not string-aware, but ES import/export statements are line-anchored
 * and never sit behind a `//` on the same line, so import detection is unaffected —
 * and a symbol mentioned only inside a comment is correctly treated as NOT used.
 *
 * @param {string} content
 * @returns {string}
 */
export function stripTsComments(content) {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}
