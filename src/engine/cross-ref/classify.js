import { basename, extname } from "node:path";
import { LANGUAGE_EXTENSIONS } from "../files.js";
import { ENTRY_POINT_NAMES, TEST_FILE_PATTERNS } from "./constants.js";

export function detectLanguage(filePath) {
  const ext = extname(filePath);
  for (const [lang, exts] of Object.entries(LANGUAGE_EXTENSIONS)) {
    if (exts.includes(ext)) return lang;
  }
  return null;
}

export function isTestFile(filePath) {
  const name = basename(filePath);
  return TEST_FILE_PATTERNS.some((re) => re.test(name));
}

export function isEntryPoint(filePath) {
  return ENTRY_POINT_NAMES.has(basename(filePath));
}
