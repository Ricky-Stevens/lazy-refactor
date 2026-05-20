import { execSync } from 'node:child_process';

/** @type {boolean|null} */
let _ripgrepAvailable = null;

/**
 * Check if `rg` is on PATH. Result is cached after first call.
 * @returns {Promise<boolean>}
 */
export async function isRipgrepAvailable() {
  if (_ripgrepAvailable !== null) return _ripgrepAvailable;
  try {
    execSync('rg --version', { stdio: 'ignore' });
    _ripgrepAvailable = true;
  } catch {
    // rg is not installed or not on PATH — suppress intentionally
    _ripgrepAvailable = false;
  }
  return _ripgrepAvailable;
}

/**
 * Convert a simple glob pattern to a RegExp for file path matching.
 * Supports **, *, ?, and {a,b} alternation.
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegex(glob) {
  // Expand {a,b,c} alternations first
  const expanded = glob.replace(/\{([^}]+)\}/g, (_, inner) => {
    const alts = inner.split(',').map((s) => s.trim());
    return `(${alts.map(escapeForGlob).join('|')})`;
  });

  let regStr = '';
  let i = 0;
  while (i < expanded.length) {
    if (expanded[i] === '(' || expanded[i] === ')' || expanded[i] === '|') {
      // Already regex from alternation expansion
      regStr += expanded[i];
      i++;
    } else if (expanded.startsWith('**/', i)) {
      regStr += '(.+/)?';
      i += 3;
    } else if (expanded.startsWith('**', i)) {
      regStr += '.*';
      i += 2;
    } else if (expanded[i] === '*') {
      regStr += '[^/]*';
      i++;
    } else if (expanded[i] === '?') {
      regStr += '[^/]';
      i++;
    } else {
      regStr += escapeForGlob(expanded[i]);
      i++;
    }
  }
  return new RegExp(`^${regStr}$`);
}

function escapeForGlob(ch) {
  return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check whether a file path matches any of the given exclude globs.
 * @param {string} filePath
 * @param {string[]} excludeGlobs
 * @returns {boolean}
 */
function isExcluded(filePath, excludeGlobs) {
  // Normalise path — remove leading ./
  const normalised = filePath.replace(/^\.\//, '');
  return excludeGlobs.some((glob) => {
    const rx = globToRegex(glob);
    // Match against full path or just the basename segment
    return rx.test(normalised) || rx.test(normalised.split('/').pop() ?? '');
  });
}

/**
 * Build the shell command string for pattern search.
 * @param {string} pattern       PCRE2 regex
 * @param {string} filePattern   Glob (e.g. "**\/*.ts")
 * @param {string[]} excludes    Glob patterns to exclude
 * @param {boolean} useRipgrep
 * @returns {string}
 */
export function buildGrepCommand(pattern, filePattern, excludes, useRipgrep) {
  const escapedPattern = pattern.replace(/'/g, "'\\''");

  if (useRipgrep) {
    const excludeArgs = excludes
      .map((e) => `--glob '!${e}'`)
      .join(' ');
    return `rg -Pn --no-heading ${excludeArgs} -g '${filePattern}' '${escapedPattern}' .`;
  }

  // grep fallback — use find to enumerate files, then grep
  // Extract extension list from filePattern e.g. **/*.{ts,tsx,js} or **/*.py
  const braceMatch = filePattern.match(/\{([^}]+)\}/);
  let exts;
  if (braceMatch) {
    exts = braceMatch[1].split(',').map((e) => e.trim());
  } else {
    // Single extension like **/*.py or *.go
    const singleMatch = filePattern.match(/\*\.([a-zA-Z0-9]+)$/);
    exts = singleMatch ? [singleMatch[1]] : ['*'];
  }

  // Build find -name alternation
  const nameFilters = exts
    .map((ext, idx) => (idx === 0 ? `-name '*.${ext}'` : `-o -name '*.${ext}'`))
    .join(' ');

  // Build find exclusions: distinguish directory excludes from file-name excludes
  const excludeArgs = excludes
    .map((e) => {
      // Patterns like **/*.test.* are file-name patterns (not directories)
      if (e.includes('*.')) {
        // Strip leading **/ and use as a path exclude
        const stripped = e.replace(/^\*\*\//, '');
        return `-not -name '${stripped}'`;
      }
      // Directory-style patterns like node_modules/** or **/vendor/**
      const dir = e.replace(/^\*\*\//, '').replace(/\/\*\*$/, '');
      return `-not -path '*/${dir}' -not -path '*/${dir}/*'`;
    })
    .join(' ');

  return `find . \\( ${nameFilters} \\) ${excludeArgs} -print0 | xargs -0 grep -Pn '${escapedPattern}'`;
}

/**
 * Parse a single line of rg/grep output into a structured finding fragment.
 * Expected format: filepath:linenum:matchtext
 * @param {string} line
 * @returns {{file: string, line: number, match: string}|null}
 */
function parseLine(line) {
  const m = line.match(/^(.+?):(\d+):(.*)$/);
  if (!m) return null;
  return {
    file: m[1].replace(/^\.\//, ''),
    line: Number.parseInt(m[2], 10),
    match: m[3].trim(),
  };
}

/**
 * Check whether a file's content matches an antiPattern.
 * @param {string} filePath
 * @param {string} antiPattern
 * @param {boolean} useRipgrep
 * @returns {boolean}
 */
function fileMatchesAntiPattern(filePath, antiPattern, useRipgrep) {
  try {
    const escapedPattern = antiPattern.replace(/'/g, "'\\''");
    const cmd = useRipgrep
      ? `rg -Pl '${escapedPattern}' '${filePath}'`
      : `grep -Pl '${escapedPattern}' '${filePath}'`;
    const result = execSync(cmd, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return result.trim().length > 0;
  } catch {
    // Non-zero exit = no match, or command error — treat as no anti-pattern hit
    return false;
  }
}

/**
 * Scan a directory for pattern matches according to the given rules.
 *
 * @param {string} path   Directory path to scan
 * @param {Array<{
 *   id: string,
 *   severity: string,
 *   category: string,
 *   description: string,
 *   language: string,
 *   pattern: string,
 *   antiPattern: string|null,
 *   filePattern: string,
 *   exclude: string[],
 *   suggestion: string,
 *   fixable: boolean
 * }>} rules
 * @param {{exclude?: string[], languages?: string[]}} [options]
 * @returns {Promise<Array<{
 *   ruleId: string,
 *   file: string,
 *   line: number,
 *   match: string,
 *   severity: string,
 *   category: string,
 *   description: string,
 *   suggestion: string,
 *   fixable: boolean
 * }>>}
 */
export async function scanPatterns(path, rules, options = {}) {
  const { exclude: extraExcludes = [], languages = [] } = options;
  const useRipgrep = await isRipgrepAvailable();

  const findings = [];

  for (const rule of rules) {
    // Filter by requested languages ('common' always applies when languages is empty or matches)
    if (languages.length > 0) {
      const matches =
        rule.language === 'common' || languages.includes(rule.language);
      if (!matches) continue;
    }

    const allExcludes = [...(rule.exclude || []), ...extraExcludes];

    let rawOutput = '';
    try {
      const cmd = buildGrepCommand(rule.pattern, rule.filePattern, allExcludes, useRipgrep);
      rawOutput = execSync(cmd, {
        cwd: path,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
        maxBuffer: 50 * 1024 * 1024,
      });
    } catch (err) {
      // exit code 1 from grep/rg means no matches found — that's fine
      if (err.status === 1) {
        rawOutput = '';
      } else if (err.stdout) {
        rawOutput = err.stdout;
      } else {
        // Genuine error (bad regex, missing binary) — skip rule
        continue;
      }
    }

    const lines = rawOutput.split('\n').filter(Boolean);

    // Determine which files the anti-pattern excludes for this rule
    const antiPatternExcludedFiles = new Set();
    if (rule.antiPattern) {
      const hitFiles = new Set(
        lines.map((l) => parseLine(l)?.file).filter(Boolean)
      );
      for (const file of hitFiles) {
        const absFilePath = `${path}/${file}`;
        if (fileMatchesAntiPattern(absFilePath, rule.antiPattern, useRipgrep)) {
          antiPatternExcludedFiles.add(file);
        }
      }
    }

    for (const line of lines) {
      const parsed = parseLine(line);
      if (!parsed) continue;

      // Apply extra exclude globs
      if (extraExcludes.length > 0 && isExcluded(parsed.file, extraExcludes)) continue;

      // Skip files excluded by anti-pattern
      if (antiPatternExcludedFiles.has(parsed.file)) continue;

      findings.push({
        ruleId: rule.id,
        file: parsed.file,
        line: parsed.line,
        match: parsed.match,
        severity: rule.severity,
        category: rule.category,
        description: rule.description,
        suggestion: rule.suggestion,
        fixable: rule.fixable,
      });
    }
  }

  return findings;
}
