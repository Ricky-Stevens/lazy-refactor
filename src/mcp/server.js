/**
 * MCP server entry point for lazy-refactor.
 *
 * Exposes 14 tools:
 *   Scan:   run_scan, scan_duplicates, scan_dead_code, scan_metrics, scan_patterns, detect_language,
 *           scan_inconsistent_patterns, scan_over_engineering
 *   State:  get_findings, get_finding, update_finding, get_summary
 *   Config: get_config, update_config
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';

import { scanPatterns } from '../engine/pattern-scanner.js';
import { computeMetrics } from '../engine/metrics.js';
import { scanDeadCode, scanUnusedDeps, scanUnusedImports, scanInconsistentPatterns, scanOverEngineering } from '../engine/cross-ref.js';
import { scanDuplicates } from '../engine/duplicates.js';
import { scoreFinding, scoreFindings } from '../scoring/prioritizer.js';
import {
  loadFindings,
  saveFindings,
  addFindings,
  updateFinding,
  getFindings,
  getFinding,
  getSummary,
} from '../state/findings.js';

// Language-specific rule sets
import commonRules from '../rules/common.js';
import typescriptRules from '../rules/typescript.js';
import goRules from '../rules/go.js';
import pythonRules from '../rules/python.js';
import csharpRules from '../rules/csharp.js';
import javaRules from '../rules/java.js';
import outdatedPatterns from '../rules/outdated-patterns.js';
// outdated-patterns exports a Record<language, Array<{from,to,...}>> — different shape from scan rules.
// It is NOT included in buildRules(); instead it is used by checkOutdatedDeps() for migration detection.

// ─── Constants ────────────────────────────────────────────────────────────────

const CONFIG_FILE = '.lazy-refactor.json';

const DEFAULT_CONFIG = {
  thresholds: {
    maxFileLines: 300,
    maxComplexity: 15,
    maxNesting: 4,
    maxExportsPerFile: 10,
    duplicateMinTokens: 50,
    duplicateSimilarity: 0.80,
  },
  exclude: ['vendor/**', 'generated/**', 'node_modules/**', '.git/**'],
  disabledChecks: [],
  languages: 'auto',
};

/** Language name -> rule array */
const LANGUAGE_RULES = {
  typescript: typescriptRules,
  go: goRules,
  python: pythonRules,
  csharp: csharpRules,
  java: javaRules,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Deep-merge two plain objects. Arrays in `override` replace those in `base`.
 * @param {object} base
 * @param {object} override
 * @returns {object}
 */
function deepMerge(base, override) {
  const result = { ...base };
  for (const [key, val] of Object.entries(override)) {
    if (val !== null && typeof val === 'object' && !Array.isArray(val) &&
        typeof result[key] === 'object' && result[key] !== null && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key], val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

/**
 * Read and merge project config with defaults.
 * @param {string} projectPath
 * @returns {Promise<object>}
 */
async function readConfig(projectPath) {
  try {
    const raw = await readFile(join(projectPath, CONFIG_FILE), 'utf8');
    const disk = JSON.parse(raw);
    return deepMerge(DEFAULT_CONFIG, disk);
  } catch (err) {
    if (err.code === 'ENOENT') return { ...DEFAULT_CONFIG };
    throw err;
  }
}

/**
 * Write config to disk (only the non-default parts are written, but we write
 * the full merged object for simplicity / auditability).
 * @param {string} projectPath
 * @param {object} config
 */
async function writeConfig(projectPath, config) {
  await writeFile(join(projectPath, CONFIG_FILE), JSON.stringify(config, null, 2), 'utf8');
}

/**
 * Detect languages in use at a project path by inspecting marker files.
 * @param {string} projectPath
 * @returns {Promise<{languages: string[], markers: object}>}
 */
export async function detectLanguages(projectPath) {
  const markers = {};
  const languages = [];

  // Helper: try to read a file, return content or null
  async function tryRead(file) {
    try {
      return await readFile(join(projectPath, file), 'utf8');
    } catch {
      return null;
    }
  }

  // Helper: look for files matching a suffix in the project root
  async function findBySuffix(suffix) {
    try {
      const entries = await readdir(projectPath);
      return entries.filter((e) => e.endsWith(suffix));
    } catch {
      return [];
    }
  }

  // TypeScript / JavaScript: package.json with typescript dep, or tsconfig
  const pkgJson = await tryRead('package.json');
  if (pkgJson !== null) {
    markers['package.json'] = true;
    try {
      const pkg = JSON.parse(pkgJson);
      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.peerDependencies,
      };
      if (allDeps['typescript'] || allDeps['ts-node'] || allDeps['tsx']) {
        languages.push('typescript');
        markers['typescript'] = true;
      } else {
        // Plain JavaScript project
        languages.push('typescript'); // treat JS projects with package.json the same
        markers['javascript'] = true;
      }
    } catch {
      languages.push('typescript');
    }
  }

  const tsConfig = await tryRead('tsconfig.json');
  if (tsConfig !== null && !languages.includes('typescript')) {
    languages.push('typescript');
    markers['tsconfig.json'] = true;
  }

  // Go: go.mod
  const goMod = await tryRead('go.mod');
  if (goMod !== null) {
    languages.push('go');
    markers['go.mod'] = true;
  }

  // Python: requirements.txt or pyproject.toml
  const requirements = await tryRead('requirements.txt');
  if (requirements !== null) {
    if (!languages.includes('python')) languages.push('python');
    markers['requirements.txt'] = true;
  }
  const pyproject = await tryRead('pyproject.toml');
  if (pyproject !== null) {
    if (!languages.includes('python')) languages.push('python');
    markers['pyproject.toml'] = true;
  }

  // C#: *.csproj or *.sln
  const csprojFiles = await findBySuffix('.csproj');
  const slnFiles = await findBySuffix('.sln');
  if (csprojFiles.length > 0 || slnFiles.length > 0) {
    languages.push('csharp');
    if (csprojFiles.length > 0) markers[csprojFiles[0]] = true;
    if (slnFiles.length > 0) markers[slnFiles[0]] = true;
  }

  // Java: pom.xml or build.gradle
  const pomXml = await tryRead('pom.xml');
  if (pomXml !== null) {
    languages.push('java');
    markers['pom.xml'] = true;
  }
  const buildGradle = await tryRead('build.gradle');
  if (buildGradle !== null) {
    if (!languages.includes('java')) languages.push('java');
    markers['build.gradle'] = true;
  }

  return { languages, markers };
}

/**
 * Build the combined rule set for the detected languages.
 * Always includes common rules and outdated-patterns.
 * @param {string[]} languages
 * @returns {Array}
 */
function buildRules(languages) {
  // Start with common rules that apply to all languages
  const rules = [...commonRules];
  for (const lang of languages) {
    if (LANGUAGE_RULES[lang]) {
      rules.push(...LANGUAGE_RULES[lang]);
    }
  }
  return rules;
}

/**
 * Read the project's package manifest(s) and check for outdated dependencies.
 * Supports package.json (JS/TS), go.mod (Go), and requirements.txt (Python).
 * @param {string} projectPath  Directory containing the manifest
 * @param {string[]} languages  Detected language list
 * @returns {Promise<Array>}    Findings with check: 'outdated-pattern'
 */
export async function checkOutdatedDeps(projectPath, languages) {
  const findings = [];

  // Helper: try to read a file, return content or null
  async function tryRead(file) {
    try {
      return await readFile(join(projectPath, file), 'utf8');
    } catch {
      return null;
    }
  }

  // JS/TS: scan package.json dependency names
  if (languages.includes('typescript') || languages.includes('javascript')) {
    const entries = outdatedPatterns['javascript'] ?? [];
    const pkgJson = await tryRead('package.json');
    if (pkgJson !== null) {
      let pkg;
      try { pkg = JSON.parse(pkgJson); } catch { pkg = {}; }
      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.peerDependencies,
      };
      for (const entry of entries) {
        // Match by package name (the 'from' field may include extra description text)
        const depName = entry.from.split(' ')[0];
        if (allDeps[depName] !== undefined) {
          findings.push({
            check: 'outdated-pattern',
            severity: entry.severity,
            category: 'outdated',
            locations: [{ file: 'package.json', startLine: 1 }],
            description: `Outdated dependency '${entry.from}': ${entry.description}`,
            from: entry.from,
            to: entry.to,
            suggestion: `Migrate from '${entry.from}' to '${entry.to}'.`,
            fixable: false,
            confidence: 0.9,
          });
        }
      }
    }
  }

  // Go: scan go.mod for deprecated stdlib usages by checking require lines
  if (languages.includes('go')) {
    const entries = outdatedPatterns['go'] ?? [];
    const goMod = await tryRead('go.mod');
    if (goMod !== null) {
      for (const entry of entries) {
        // go.mod contains module paths in require blocks; ioutil patterns are stdlib
        // so we detect them by their detectPattern against go.mod and source via description
        // For go.mod specifically: flag if any require line references known deprecated paths
        // (ioutil is stdlib so won't appear in go.mod — we note this as a code-level pattern)
        // We still surface the finding as a migration advisory at the project level.
        findings.push({
          check: 'outdated-pattern',
          severity: entry.severity,
          category: 'outdated',
          locations: [{ file: 'go.mod', startLine: 1 }],
          description: `Potentially outdated usage '${entry.from}': ${entry.description}`,
          from: entry.from,
          to: entry.to,
          suggestion: `Migrate from '${entry.from}' to '${entry.to}'.`,
          fixable: false,
          confidence: 0.5,
        });
      }
    }
  }

  // Python: scan requirements.txt for deprecated packages
  if (languages.includes('python')) {
    const entries = outdatedPatterns['python'] ?? [];
    const requirements = await tryRead('requirements.txt');
    if (requirements !== null) {
      const lines = requirements.split('\n').map((l) => l.trim());
      for (const entry of entries) {
        const depName = entry.from.split(' ')[0].toLowerCase();
        const matched = lines.some((line) =>
          line.toLowerCase().startsWith(depName + '==') ||
          line.toLowerCase().startsWith(depName + '>=') ||
          line.toLowerCase().startsWith(depName + '>') ||
          line.toLowerCase() === depName,
        );
        if (matched) {
          findings.push({
            check: 'outdated-pattern',
            severity: entry.severity,
            category: 'outdated',
            locations: [{ file: 'requirements.txt', startLine: 1 }],
            description: `Outdated dependency '${entry.from}': ${entry.description}`,
            from: entry.from,
            to: entry.to,
            suggestion: `Migrate from '${entry.from}' to '${entry.to}'.`,
            fixable: false,
            confidence: 0.9,
          });
        }
      }
    }
  }

  return findings;
}

/**
 * Wrap a result as an MCP success content block.
 * @param {unknown} data
 * @returns {{content: Array<{type: string, text: string}>}}
 */
function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

/**
 * Wrap an error as an MCP error content block (does not throw).
 * @param {unknown} err
 * @returns {{content: Array<{type: string, text: string}>, isError: true}}
 */
function fail(err) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

// ─── Server bootstrap ─────────────────────────────────────────────────────────

const projectPath = process.cwd();

const server = new McpServer({
  name: 'lazy-refactor',
  version: '0.1.0',
});

// ─── Scan tools ───────────────────────────────────────────────────────────────

server.registerTool(
  'run_scan',
  {
    description: 'Run all (or a focused subset of) scan engines, score findings, and persist them.',
    inputSchema: z.object({
      path: z.string().describe('Directory to scan'),
      options: z.object({
        focus: z.array(z.string()).optional().describe('Subset: duplicates, dead-code, metrics, patterns, inconsistent-patterns, over-engineering, outdated'),
        exclude: z.array(z.string()).optional().describe('Additional glob patterns to exclude'),
        languages: z.array(z.string()).optional().describe('Override language detection'),
      }).optional(),
    }),
  },
  async ({ path: scanPath, options = {} }) => {
    try {
      const config = await readConfig(projectPath);
      const focus = options.focus ?? ['duplicates', 'dead-code', 'metrics', 'patterns', 'inconsistent-patterns', 'over-engineering', 'outdated'];
      const exclude = [...config.exclude, ...(options.exclude ?? [])];
      const langOverride = options.languages;

      // Determine languages
      let languages;
      if (langOverride && langOverride.length > 0) {
        languages = langOverride;
      } else if (config.languages !== 'auto') {
        languages = Array.isArray(config.languages) ? config.languages : [config.languages];
      } else {
        const detected = await detectLanguages(scanPath);
        languages = detected.languages;
      }

      const rules = buildRules(languages);
      const allFindings = [];

      if (focus.includes('duplicates')) {
        const dupes = await scanDuplicates(scanPath, {
          minTokens: config.thresholds.duplicateMinTokens,
          similarity: config.thresholds.duplicateSimilarity,
          exclude,
          languages,
        });
        allFindings.push(...dupes.map((f) => ({
          check: f.check,
          severity: 'medium',
          category: 'duplication',
          locations: [{ file: f.fileA, startLine: f.startLineA, endLine: f.endLineA }],
          description: `Duplicate code block between ${f.fileA} and ${f.fileB}`,
          similarity: f.similarity,
          tokenCount: f.tokenCount,
          fileB: f.fileB,
          startLineB: f.startLineB,
          endLineB: f.endLineB,
          suggestion: 'Extract shared logic into a reusable function or module.',
          fixable: false,
          confidence: f.similarity,
        })));
      }

      if (focus.includes('dead-code')) {
        const dead = await scanDeadCode(scanPath, {}, { exclude, languages });
        allFindings.push(...dead.map((f) => ({
          check: f.check,
          severity: 'low',
          category: 'dead-code',
          locations: [{ file: f.file.replace(scanPath + '/', ''), startLine: f.exportLine + 1 }],
          description: `Exported symbol '${f.symbol}' appears unused`,
          symbol: f.symbol,
          suggestion: 'Remove the export or verify it is consumed externally.',
          fixable: false,
          confidence: f.confidence,
        })));

        const unusedDeps = await scanUnusedDeps(scanPath, { exclude });
        allFindings.push(...unusedDeps.map((f) => ({
          check: f.check,
          severity: 'low',
          category: 'dead-code',
          locations: [],
          description: `Dependency '${f.dep}' declared in ${f.manifest} manifest but not referenced in source`,
          dep: f.dep,
          suggestion: 'Remove the dependency or verify it is used via dynamic require.',
          fixable: false,
          confidence: 0.7,
        })));

        const unusedImports = await scanUnusedImports(scanPath, { exclude, languages });
        allFindings.push(...unusedImports.map((f) => ({
          check: f.check,
          severity: 'low',
          category: 'dead-code',
          locations: [{ file: f.file.replace(scanPath + '/', ''), startLine: f.importLine + 1 }],
          description: `Import '${f.symbol}' is never used`,
          symbol: f.symbol,
          suggestion: 'Remove the unused import.',
          fixable: true,
          confidence: 0.85,
        })));
      }

      if (focus.includes('metrics')) {
        const { findings: metricFindings } = await computeMetrics(scanPath, {
          maxFileLines: config.thresholds.maxFileLines,
          maxComplexity: config.thresholds.maxComplexity,
          maxNesting: config.thresholds.maxNesting,
          languages,
        });
        allFindings.push(...metricFindings.map((f) => ({
          check: f.ruleId,
          severity: f.severity,
          category: f.category,
          locations: [{ file: f.file, startLine: f.line }],
          description: f.description,
          suggestion: f.suggestion,
          fixable: f.fixable,
          confidence: 0.95,
        })));
      }

      if (focus.includes('patterns')) {
        const patternFindings = await scanPatterns(scanPath, rules, { exclude, languages });
        allFindings.push(...patternFindings.map((f) => ({
          check: f.ruleId,
          severity: f.severity,
          category: f.category,
          locations: [{ file: f.file, startLine: f.line }],
          description: f.description,
          suggestion: f.suggestion,
          fixable: f.fixable,
          confidence: 0.9,
        })));
      }

      if (focus.includes('inconsistent-patterns')) {
        const inconsistentFindings = await scanInconsistentPatterns(scanPath, { exclude, languages });
        allFindings.push(...inconsistentFindings.map((f) => ({
          check: f.check ?? 'inconsistent-pattern',
          severity: f.severity ?? 'low',
          category: f.category ?? 'consistency',
          locations: f.locations ?? (f.file ? [{ file: f.file.replace(scanPath + '/', ''), startLine: f.line ?? 1 }] : []),
          description: f.description,
          suggestion: f.suggestion ?? 'Align with the predominant pattern used elsewhere in the codebase.',
          fixable: f.fixable ?? false,
          confidence: f.confidence ?? 0.75,
        })));
      }

      if (focus.includes('over-engineering')) {
        const overEngFindings = await scanOverEngineering(scanPath, { exclude, languages });
        allFindings.push(...overEngFindings.map((f) => ({
          check: f.check ?? 'over-engineering',
          severity: f.severity ?? 'low',
          category: f.category ?? 'complexity',
          locations: f.locations ?? (f.file ? [{ file: f.file.replace(scanPath + '/', ''), startLine: f.line ?? 1 }] : []),
          description: f.description,
          suggestion: f.suggestion ?? 'Simplify to the minimum viable abstraction.',
          fixable: f.fixable ?? false,
          confidence: f.confidence ?? 0.7,
        })));
      }

      if (focus.includes('outdated')) {
        const outdatedFindings = await checkOutdatedDeps(scanPath, languages);
        allFindings.push(...outdatedFindings);
      }

      // Score findings
      const scored = scoreFindings(allFindings);

      // Persist
      const scanId = `scan-${Date.now()}`;
      await addFindings(projectPath, scored, scanId, scanPath);

      const summary = await getSummary(projectPath);
      return ok({ scanId, totalFindings: scored.length, summary });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'scan_duplicates',
  {
    description: 'Scan a directory for duplicate code blocks.',
    inputSchema: z.object({
      path: z.string().describe('Directory to scan'),
      minTokens: z.number().optional().describe('Minimum token window size (default 50)'),
      similarity: z.number().optional().describe('Minimum similarity ratio 0–1 (default 0.80)'),
    }),
  },
  async ({ path: scanPath, minTokens, similarity }) => {
    try {
      const findings = await scanDuplicates(scanPath, { minTokens, similarity });
      return ok(findings);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'scan_dead_code',
  {
    description: 'Scan for dead code: unused exports, unused dependencies, and unused imports.',
    inputSchema: z.object({
      path: z.string().describe('Directory to scan'),
    }),
  },
  async ({ path: scanPath }) => {
    try {
      const [dead, unusedDeps, unusedImports] = await Promise.all([
        scanDeadCode(scanPath),
        scanUnusedDeps(scanPath),
        scanUnusedImports(scanPath),
      ]);
      return ok({ deadCode: dead, unusedDeps, unusedImports });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'scan_metrics',
  {
    description: 'Compute per-file complexity and size metrics.',
    inputSchema: z.object({
      path: z.string().describe('Directory to scan'),
      thresholds: z.object({
        maxFileLines: z.number().optional(),
        maxComplexity: z.number().optional(),
        maxNesting: z.number().optional(),
      }).optional(),
    }),
  },
  async ({ path: scanPath, thresholds }) => {
    try {
      const result = await computeMetrics(scanPath, thresholds ?? {});
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'scan_patterns',
  {
    description: 'Scan for anti-pattern rule violations.',
    inputSchema: z.object({
      path: z.string().describe('Directory to scan'),
      categories: z.array(z.string()).optional().describe('Filter to specific categories'),
    }),
  },
  async ({ path: scanPath, categories }) => {
    try {
      const config = await readConfig(projectPath);
      const detected = await detectLanguages(scanPath);
      const rules = buildRules(detected.languages);
      const filtered = categories && categories.length > 0
        ? rules.filter((r) => categories.includes(r.category))
        : rules;
      const findings = await scanPatterns(scanPath, filtered, { exclude: config.exclude });
      return ok(findings);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'scan_inconsistent_patterns',
  {
    description: 'Scan for inconsistent coding patterns across the codebase (Check 10).',
    inputSchema: z.object({
      path: z.string().describe('Directory to scan'),
    }),
  },
  async ({ path: scanPath }) => {
    try {
      const findings = await scanInconsistentPatterns(scanPath, {});
      return ok(findings);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'scan_over_engineering',
  {
    description: 'Scan for over-engineered abstractions and unnecessary complexity (Check 13).',
    inputSchema: z.object({
      path: z.string().describe('Directory to scan'),
    }),
  },
  async ({ path: scanPath }) => {
    try {
      const findings = await scanOverEngineering(scanPath, {});
      return ok(findings);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'detect_language',
  {
    description: 'Detect the programming languages in use at a project path.',
    inputSchema: z.object({
      path: z.string().describe('Project directory path'),
    }),
  },
  async ({ path: scanPath }) => {
    try {
      const result = await detectLanguages(scanPath);
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  },
);

// ─── State tools ──────────────────────────────────────────────────────────────

server.registerTool(
  'get_findings',
  {
    description: 'Return persisted findings, optionally filtered.',
    inputSchema: z.object({
      filter: z.object({
        severity: z.union([z.string(), z.array(z.string())]).optional(),
        category: z.union([z.string(), z.array(z.string())]).optional(),
        status: z.union([z.string(), z.array(z.string())]).optional(),
        language: z.union([z.string(), z.array(z.string())]).optional(),
      }).optional(),
    }),
  },
  async ({ filter }) => {
    try {
      const findings = await getFindings(projectPath, filter ?? {});
      return ok(findings);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'get_finding',
  {
    description: 'Return a single finding by ID.',
    inputSchema: z.object({
      id: z.string().describe('Finding ID'),
    }),
  },
  async ({ id }) => {
    try {
      const finding = await getFinding(projectPath, id);
      if (!finding) {
        return fail(new Error(`Finding '${id}' not found`));
      }
      return ok(finding);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'update_finding',
  {
    description: 'Update the status and/or notes on a finding.',
    inputSchema: z.object({
      id: z.string().describe('Finding ID'),
      status: z.string().describe('New status: open | fixed | ignored | in-progress | false-positive'),
      notes: z.string().optional().describe('Optional notes'),
    }),
  },
  async ({ id, status, notes }) => {
    try {
      const updated = await updateFinding(projectPath, id, { status, notes });
      if (!updated) {
        return fail(new Error(`Finding '${id}' not found`));
      }
      return ok(updated);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'get_summary',
  {
    description: 'Return summary statistics for all persisted findings.',
    inputSchema: z.object({}),
  },
  async () => {
    try {
      const summary = await getSummary(projectPath);
      return ok(summary);
    } catch (err) {
      return fail(err);
    }
  },
);

// ─── Config tools ─────────────────────────────────────────────────────────────

server.registerTool(
  'get_config',
  {
    description: 'Read project config, merged with defaults.',
    inputSchema: z.object({}),
  },
  async () => {
    try {
      const config = await readConfig(projectPath);
      return ok(config);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'update_config',
  {
    description: 'Deep-merge overrides into project config and write .lazy-refactor.json.',
    inputSchema: z.object({
      overrides: z.record(z.unknown()).describe('Config fields to merge'),
    }),
  },
  async ({ overrides }) => {
    try {
      const current = await readConfig(projectPath);
      const updated = deepMerge(current, overrides);
      await writeConfig(projectPath, updated);
      return ok(updated);
    } catch (err) {
      return fail(err);
    }
  },
);

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Use stderr to avoid corrupting the JSON-RPC stdio channel
  process.stderr.write('lazy-refactor MCP server running\n');
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
