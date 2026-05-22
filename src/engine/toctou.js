import { detectLanguage, isTestFile } from "./cross-ref/classify.js";
import { collectFiles, readFilesBatched } from "./files.js";

const LANG_PATTERNS = {
  typescript: {
    check: /\b(?:existsSync|accessSync)\s*\(/,
    write:
      /\b(?:writeFileSync|unlinkSync|renameSync|mkdirSync|rmSync|appendFileSync|copyFileSync)\s*\(/,
    safe: /["']wx["']|O_EXCL/,
  },
  python: {
    check: /\b(?:os\.path\.exists|os\.path\.isfile|os\.path\.isdir|os\.access)\s*\(/,
    write:
      /\b(?:os\.remove|os\.unlink|os\.rename|os\.mkdir|os\.makedirs|shutil\.rmtree|shutil\.copy|shutil\.move)\s*\(/,
    safe: /os\.O_EXCL|exist_ok\s*=\s*True|tempfile\./,
  },
};

const IF_RE = /\bif\b/;
const LOOKAHEAD = 8;

/**
 * Scan for TOCTOU (time-of-check-to-time-of-use) race conditions.
 * Detects existence-check → file-mutation patterns within a small line window.
 * @param {string} path
 * @param {object} [options]
 * @param {string[]} [options.exclude]
 * @param {string[]} [options.languages]
 * @returns {Promise<Array<{check: string, file: string, line: number, description: string}>>}
 */
export async function scanToctou(path, options = {}) {
  const files = await collectFiles(path, options);
  const contents = await readFilesBatched(files);
  const findings = [];

  for (const [file, content] of contents) {
    if (isTestFile(file)) continue;
    const language = detectLanguage(file);
    if (!language) continue;
    const patterns = LANG_PATTERNS[language];
    if (!patterns) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!patterns.check.test(lines[i])) continue;
      if (!IF_RE.test(lines[i]) && (i === 0 || !IF_RE.test(lines[i - 1]))) continue;

      for (let j = i + 1; j < Math.min(i + LOOKAHEAD + 1, lines.length); j++) {
        if (patterns.write.test(lines[j])) {
          const block = lines.slice(i, j + 1).join("\n");
          if (patterns.safe.test(block)) break;
          findings.push({
            check: "toctou-race",
            file,
            line: i + 1,
            description: `Potential TOCTOU race: existence check at line ${i + 1} followed by file mutation at line ${j + 1}`,
          });
          break;
        }
      }
    }
  }

  return findings;
}
