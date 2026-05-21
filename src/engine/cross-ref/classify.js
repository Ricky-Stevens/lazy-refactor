import { basename, extname } from "node:path";
import { LANGUAGE_EXTENSIONS } from "../files.js";
import { ENTRY_POINT_NAMES, TEST_FILE_PATTERNS } from "./constants.js";

/**
 * Detect the language of a file by its extension.
 * @param {string} filePath
 * @returns {string|null}
 */
export function detectLanguage(filePath) {
  const ext = extname(filePath);
  for (const [lang, exts] of Object.entries(LANGUAGE_EXTENSIONS)) {
    if (exts.includes(ext)) return lang;
  }
  return null;
}

/**
 * Check if a file is a test file.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isTestFile(filePath) {
  const name = basename(filePath);
  return TEST_FILE_PATTERNS.some((re) => re.test(name));
}

/**
 * Check if a file is an entry point.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isEntryPoint(filePath) {
  return ENTRY_POINT_NAMES.has(basename(filePath));
}
