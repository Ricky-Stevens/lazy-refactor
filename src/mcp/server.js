/**
 * MCP server entry point for lazy-refactor.
 *
 * Exposes 15 tools:
 *   Scan:   run_scan, scan_duplicates, scan_dead_code, scan_metrics, scan_patterns, detect_language,
 *           scan_inconsistent_patterns, scan_over_engineering
 *   State:  get_findings, get_finding, update_finding, get_summary, clear_findings
 *   Config: get_config, update_config
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";
import { scanDeadCode, scanUnusedDeps, scanUnusedImports } from "../engine/cross-ref.js";
import { detectLanguages } from "../engine/detect.js";
import { scanDuplicates } from "../engine/duplicates.js";
import { computeMetrics } from "../engine/metrics.js";
import { checkOutdatedDeps } from "../engine/outdated.js";
import { scanPatterns } from "../engine/pattern-scanner.js";
import { scanInconsistentPatterns, scanOverEngineering } from "../engine/patterns.js";
// Language-specific rule sets
import commonRules from "../rules/common.js";
import csharpRules from "../rules/csharp.js";
import goRules from "../rules/go.js";
import javaRules from "../rules/java.js";
import pythonRules from "../rules/python.js";
import typescriptRules from "../rules/typescript.js";
import { scoreFindings } from "../scoring/prioritizer.js";
import {
  addFindings,
  clearFindings,
  getFinding,
  getFindings,
  getSummary,
  updateFinding,
} from "../state/findings.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const CONFIG_FILE = ".lazy-refactor.json";

const DEFAULT_CONFIG = {
  thresholds: {
    maxFileLines: 300,
    maxComplexity: 15,
    maxNesting: 4,
    maxExportsPerFile: 10,
    maxImportsPerFile: 15,
    duplicateMinTokens: 50,
    duplicateSimilarity: 0.8,
  },
  exclude: ["vendor/**", "generated/**", "*.generated.*", "node_modules/**", ".git/**"],
  disabledChecks: [],
  languages: "auto",
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
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (
      val !== null &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

/**
 * Validate and resolve a scan path. Ensures it exists and is a directory.
 * @param {string} inputPath
 * @returns {Promise<string>} resolved absolute path
 */
async function validateScanPath(inputPath) {
  const resolved = resolve(inputPath);
  const info = await stat(resolved);
  if (!info.isDirectory()) {
    throw new Error(`Path is not a directory: ${resolved}`);
  }
  return resolved;
}

/**
 * Read and merge project config with defaults.
 * @param {string} projectPath
 * @returns {Promise<object>}
 */
async function readConfig(projectPath) {
  try {
    const raw = await readFile(join(projectPath, CONFIG_FILE), "utf8");
    const disk = JSON.parse(raw);
    return deepMerge(DEFAULT_CONFIG, disk);
  } catch (err) {
    if (err.code === "ENOENT") return { ...DEFAULT_CONFIG };
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
  await writeFile(join(projectPath, CONFIG_FILE), JSON.stringify(config, null, 2), "utf8");
}

/**
 * Build the combined rule set for the detected languages.
 * Always includes common rules.
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
 * Wrap a result as an MCP success content block.
 * @param {unknown} data
 * @returns {{content: Array<{type: string, text: string}>}}
 */
function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

/**
 * Wrap an error as an MCP error content block (does not throw).
 * @param {unknown} err
 * @returns {{content: Array<{type: string, text: string}>, isError: true}}
 */
function fail(err) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

// ─── Server bootstrap ─────────────────────────────────────────────────────────

const projectPath = process.cwd();

const server = new McpServer({
  name: "lazy-refactor",
  version: "0.2.0",
});

// ─── Scan tools ───────────────────────────────────────────────────────────────

server.registerTool(
  "run_scan",
  {
    description: "Run all (or a focused subset of) scan engines, score findings, and persist them.",
    inputSchema: z.object({
      path: z.string().describe("Directory to scan"),
      options: z
        .object({
          focus: z
            .array(z.string())
            .optional()
            .describe(
              "Subset: duplicates, dead-code, metrics, patterns, inconsistent-patterns, over-engineering, outdated",
            ),
          exclude: z.array(z.string()).optional().describe("Additional glob patterns to exclude"),
          languages: z.array(z.string()).optional().describe("Override language detection"),
        })
        .optional(),
    }),
  },
  async ({ path: scanPath, options = {} }) => {
    try {
      const resolvedPath = await validateScanPath(scanPath);
      const config = await readConfig(projectPath);
      const focus = options.focus ?? [
        "duplicates",
        "dead-code",
        "metrics",
        "patterns",
        "inconsistent-patterns",
        "over-engineering",
        "outdated",
      ];
      const exclude = [...config.exclude, ...(options.exclude ?? [])];
      const langOverride = options.languages;

      // Determine languages
      let languages;
      if (langOverride && langOverride.length > 0) {
        languages = langOverride;
      } else if (config.languages !== "auto") {
        languages = Array.isArray(config.languages) ? config.languages : [config.languages];
      } else {
        const detected = await detectLanguages(resolvedPath);
        languages = detected.languages;
      }

      const rules = buildRules(languages);
      const allFindings = [];

      if (focus.includes("duplicates")) {
        const dupes = await scanDuplicates(resolvedPath, {
          minTokens: config.thresholds.duplicateMinTokens,
          similarity: config.thresholds.duplicateSimilarity,
          exclude,
          languages,
        });
        allFindings.push(
          ...dupes.map((f) => ({
            check: f.check,
            severity: "medium",
            category: "duplication",
            locations: [{ file: f.fileA, startLine: f.startLineA, endLine: f.endLineA }],
            description: `Duplicate code block between ${f.fileA} and ${f.fileB}`,
            similarity: f.similarity,
            tokenCount: f.tokenCount,
            fileB: f.fileB,
            startLineB: f.startLineB,
            endLineB: f.endLineB,
            suggestion: "Extract shared logic into a reusable function or module.",
            fixable: false,
            confidence: f.similarity,
            language: f.language ?? "common",
          })),
        );
      }

      if (focus.includes("dead-code")) {
        const dead = await scanDeadCode(resolvedPath, {}, { exclude, languages });
        allFindings.push(
          ...dead.map((f) => ({
            check: f.check,
            severity: "low",
            category: "dead-code",
            locations: [
              { file: f.file.replace(`${resolvedPath}/`, ""), startLine: f.exportLine + 1 },
            ],
            description: `Exported symbol '${f.symbol}' appears unused`,
            symbol: f.symbol,
            suggestion: "Remove the export or verify it is consumed externally.",
            fixable: false,
            confidence: f.confidence,
            language: f.language ?? "common",
          })),
        );

        const unusedDeps = await scanUnusedDeps(resolvedPath, { exclude });
        allFindings.push(
          ...unusedDeps.map((f) => ({
            check: f.check,
            severity: "low",
            category: "dead-code",
            locations: [],
            description: `Dependency '${f.dep}' declared in ${f.manifest} manifest but not referenced in source`,
            dep: f.dep,
            suggestion: "Remove the dependency or verify it is used via dynamic require.",
            fixable: false,
            confidence: 0.7,
            language: f.language ?? "common",
          })),
        );

        const unusedImports = await scanUnusedImports(resolvedPath, { exclude, languages });
        allFindings.push(
          ...unusedImports.map((f) => ({
            check: f.check,
            severity: "low",
            category: "dead-code",
            locations: [
              { file: f.file.replace(`${resolvedPath}/`, ""), startLine: f.importLine + 1 },
            ],
            description: `Import '${f.symbol}' is never used`,
            symbol: f.symbol,
            suggestion: "Remove the unused import.",
            fixable: true,
            confidence: 0.85,
            language: f.language ?? "common",
          })),
        );
      }

      if (focus.includes("metrics")) {
        const { findings: metricFindings } = await computeMetrics(resolvedPath, {
          maxFileLines: config.thresholds.maxFileLines,
          maxComplexity: config.thresholds.maxComplexity,
          maxNesting: config.thresholds.maxNesting,
          maxExportsPerFile: config.thresholds.maxExportsPerFile,
          maxImportsPerFile: config.thresholds.maxImportsPerFile,
          languages,
          exclude,
        });
        allFindings.push(
          ...metricFindings.map((f) => ({
            check: f.ruleId,
            severity: f.severity,
            category: f.category,
            locations: [{ file: f.file, startLine: f.line }],
            description: f.description,
            suggestion: f.suggestion,
            fixable: f.fixable,
            confidence: 0.95,
            language: f.language ?? "common",
          })),
        );
      }

      if (focus.includes("patterns")) {
        const patternFindings = await scanPatterns(resolvedPath, rules, { exclude, languages });
        allFindings.push(
          ...patternFindings.map((f) => ({
            check: f.ruleId,
            severity: f.severity,
            category: f.category,
            locations: [{ file: f.file, startLine: f.line }],
            description: f.description,
            suggestion: f.suggestion,
            fixable: f.fixable,
            confidence: 0.9,
            language: f.language ?? "common",
          })),
        );
      }

      if (focus.includes("inconsistent-patterns")) {
        const inconsistentFindings = await scanInconsistentPatterns(resolvedPath, {
          exclude,
          languages,
        });
        allFindings.push(
          ...inconsistentFindings.map((f) => ({
            check: f.check ?? "inconsistent-pattern",
            severity: f.severity ?? "low",
            category: f.category ?? "consistency",
            locations:
              f.locations ??
              (f.file
                ? [{ file: f.file.replace(`${resolvedPath}/`, ""), startLine: f.line ?? 1 }]
                : []),
            description: f.description,
            suggestion:
              f.suggestion ?? "Align with the predominant pattern used elsewhere in the codebase.",
            fixable: f.fixable ?? false,
            confidence: f.confidence ?? 0.75,
            language: f.language ?? "common",
          })),
        );
      }

      if (focus.includes("over-engineering")) {
        const overEngFindings = await scanOverEngineering(resolvedPath, { exclude, languages });
        allFindings.push(
          ...overEngFindings.map((f) => ({
            check: f.check ?? "over-engineering",
            severity: f.severity ?? "low",
            category: f.category ?? "complexity",
            locations:
              f.locations ??
              (f.file
                ? [{ file: f.file.replace(`${resolvedPath}/`, ""), startLine: f.line ?? 1 }]
                : []),
            description: f.description,
            suggestion: f.suggestion ?? "Simplify to the minimum viable abstraction.",
            fixable: f.fixable ?? false,
            confidence: f.confidence ?? 0.7,
            language: f.language ?? "common",
          })),
        );
      }

      if (focus.includes("outdated")) {
        const outdatedFindings = await checkOutdatedDeps(resolvedPath, languages);
        allFindings.push(...outdatedFindings);
      }

      // Filter out disabled checks
      const filtered =
        config.disabledChecks && config.disabledChecks.length > 0
          ? allFindings.filter((f) => !config.disabledChecks.includes(f.check))
          : allFindings;

      // Score findings
      const scored = scoreFindings(filtered);

      // Persist
      const scanId = `scan-${Date.now()}`;
      await addFindings(projectPath, scored, scanId, resolvedPath);

      const summary = await getSummary(projectPath);
      return ok({ scanId, totalFindings: scored.length, summary });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "scan_duplicates",
  {
    description:
      "Scan a directory for duplicate code blocks. Returns raw results without persisting. Use run_scan to persist findings.",
    inputSchema: z.object({
      path: z.string().describe("Directory to scan"),
      minTokens: z.number().optional().describe("Minimum token window size (default 50)"),
      similarity: z.number().optional().describe("Minimum similarity ratio 0–1 (default 0.80)"),
    }),
  },
  async ({ path: scanPath, minTokens, similarity }) => {
    try {
      const resolvedPath = await validateScanPath(scanPath);
      const config = await readConfig(projectPath);
      const findings = await scanDuplicates(resolvedPath, {
        minTokens,
        similarity,
        exclude: config.exclude,
      });
      return ok(findings);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "scan_dead_code",
  {
    description:
      "Scan for dead code: unused exports, unused dependencies, and unused imports. Returns raw results without persisting. Use run_scan to persist findings.",
    inputSchema: z.object({
      path: z.string().describe("Directory to scan"),
    }),
  },
  async ({ path: scanPath }) => {
    try {
      const resolvedPath = await validateScanPath(scanPath);
      const config = await readConfig(projectPath);
      const detected = await detectLanguages(resolvedPath);
      const langs = detected.languages;
      const [dead, unusedDeps, unusedImports] = await Promise.all([
        scanDeadCode(resolvedPath, {}, { exclude: config.exclude, languages: langs }),
        scanUnusedDeps(resolvedPath, { exclude: config.exclude }),
        scanUnusedImports(resolvedPath, { exclude: config.exclude, languages: langs }),
      ]);
      return ok({ deadCode: dead, unusedDeps, unusedImports });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "scan_metrics",
  {
    description:
      "Compute per-file complexity and size metrics. Returns raw results without persisting. Use run_scan to persist findings.",
    inputSchema: z.object({
      path: z.string().describe("Directory to scan"),
      thresholds: z
        .object({
          maxFileLines: z.number().optional(),
          maxComplexity: z.number().optional(),
          maxNesting: z.number().optional(),
        })
        .optional(),
    }),
  },
  async ({ path: scanPath, thresholds }) => {
    try {
      const resolvedPath = await validateScanPath(scanPath);
      const config = await readConfig(projectPath);
      const detected = await detectLanguages(resolvedPath);
      const mergedThresholds = { ...config.thresholds, ...(thresholds ?? {}) };
      const result = await computeMetrics(resolvedPath, {
        ...mergedThresholds,
        languages: detected.languages,
        exclude: config.exclude,
      });
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "scan_patterns",
  {
    description:
      "Scan for anti-pattern rule violations. Returns raw results without persisting. Use run_scan to persist findings.",
    inputSchema: z.object({
      path: z.string().describe("Directory to scan"),
      categories: z.array(z.string()).optional().describe("Filter to specific categories"),
    }),
  },
  async ({ path: scanPath, categories }) => {
    try {
      const resolvedPath = await validateScanPath(scanPath);
      const config = await readConfig(projectPath);
      const detected = await detectLanguages(resolvedPath);
      const rules = buildRules(detected.languages);
      const filtered =
        categories && categories.length > 0
          ? rules.filter((r) => categories.includes(r.category))
          : rules;
      const findings = await scanPatterns(resolvedPath, filtered, {
        exclude: config.exclude,
        languages: detected.languages,
      });
      return ok(findings);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "scan_inconsistent_patterns",
  {
    description:
      "Scan for inconsistent coding patterns across the codebase (Check 10). Returns raw results without persisting. Use run_scan to persist findings.",
    inputSchema: z.object({
      path: z.string().describe("Directory to scan"),
    }),
  },
  async ({ path: scanPath }) => {
    try {
      const resolvedPath = await validateScanPath(scanPath);
      const config = await readConfig(projectPath);
      const detected = await detectLanguages(resolvedPath);
      const findings = await scanInconsistentPatterns(resolvedPath, {
        exclude: config.exclude,
        languages: detected.languages,
      });
      return ok(findings);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "scan_over_engineering",
  {
    description:
      "Scan for over-engineered abstractions and unnecessary complexity (Check 13). Returns raw results without persisting. Use run_scan to persist findings.",
    inputSchema: z.object({
      path: z.string().describe("Directory to scan"),
    }),
  },
  async ({ path: scanPath }) => {
    try {
      const resolvedPath = await validateScanPath(scanPath);
      const config = await readConfig(projectPath);
      const detected = await detectLanguages(resolvedPath);
      const findings = await scanOverEngineering(resolvedPath, {
        exclude: config.exclude,
        languages: detected.languages,
      });
      return ok(findings);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "detect_language",
  {
    description: "Detect the programming languages in use at a project path.",
    inputSchema: z.object({
      path: z.string().describe("Project directory path"),
    }),
  },
  async ({ path: scanPath }) => {
    try {
      const resolvedPath = await validateScanPath(scanPath);
      const result = await detectLanguages(resolvedPath);
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  },
);

// ─── State tools ──────────────────────────────────────────────────────────────

server.registerTool(
  "get_findings",
  {
    description: "Return persisted findings, optionally filtered. Supports pagination.",
    inputSchema: z.object({
      filter: z
        .object({
          severity: z.union([z.string(), z.array(z.string())]).optional(),
          category: z.union([z.string(), z.array(z.string())]).optional(),
          status: z.union([z.string(), z.array(z.string())]).optional(),
          language: z.union([z.string(), z.array(z.string())]).optional(),
        })
        .optional(),
      limit: z.number().optional().describe("Maximum findings to return (default 200)"),
      offset: z.number().optional().describe("Skip this many findings (for pagination)"),
    }),
  },
  async ({ filter, limit, offset }) => {
    try {
      const filtered = await getFindings(projectPath, filter ?? {});
      const total = filtered.length;
      const effectiveOffset = offset ?? 0;
      const effectiveLimit = limit ?? 200;
      let results = filtered;
      if (effectiveOffset) results = results.slice(effectiveOffset);
      results = results.slice(0, effectiveLimit);
      return ok({
        findings: results,
        total,
        offset: effectiveOffset,
        limit: effectiveLimit,
        truncated: total > effectiveOffset + effectiveLimit,
      });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_finding",
  {
    description: "Return a single finding by ID.",
    inputSchema: z.object({
      id: z.string().describe("Finding ID"),
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
  "update_finding",
  {
    description: "Update the status and/or notes on a finding.",
    inputSchema: z.object({
      id: z.string().describe("Finding ID"),
      status: z
        .enum(["open", "fixed", "ignored", "in-progress", "false-positive", "stale"])
        .describe("New status"),
      notes: z.string().optional().describe("Optional notes"),
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
  "clear_findings",
  {
    description: "Clear all persisted findings and reset scan state.",
    inputSchema: z.object({}),
  },
  async () => {
    try {
      await clearFindings(projectPath);
      return ok({ cleared: true });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_summary",
  {
    description: "Return summary statistics for all persisted findings.",
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
  "get_config",
  {
    description: "Read project config, merged with defaults.",
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
  "update_config",
  {
    description: "Deep-merge overrides into project config and write .lazy-refactor.json.",
    inputSchema: z.object({
      overrides: z.record(z.unknown()).describe("Config fields to merge"),
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
  process.stderr.write("lazy-refactor MCP server running\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});

// Re-export engine functions that tests import directly from this module.
export { checkOutdatedDeps, detectLanguages };
