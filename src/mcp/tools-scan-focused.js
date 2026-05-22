/**
 * Focused scan tool registrations for the lazy-refactor MCP server.
 *
 * Tools: scan_duplicates, scan_dead_code, scan_metrics, scan_patterns,
 *        scan_inconsistent_patterns, scan_over_engineering, detect_language
 */

import * as z from "zod";
import { scanDeadCode, scanUnusedDeps, scanUnusedImports } from "../engine/cross-ref.js";
import { detectLanguages } from "../engine/detect.js";
import { scanDuplicates } from "../engine/duplicates.js";
import { computeMetrics } from "../engine/metrics.js";
import { scanPatterns } from "../engine/pattern-scanner.js";
import { scanInconsistentPatterns, scanOverEngineering } from "../engine/patterns.js";
import { buildRules, fail, ok, readConfig, validateScanPath } from "./helpers.js";

/**
 * Resolve scan path, config, and detected languages in one call.
 * @param {string} scanPath
 * @param {string} projectPath
 * @returns {{ resolvedPath: string, config: object, langs: string[] }}
 */
async function resolveScanContext(scanPath, projectPath) {
  const resolvedPath = await validateScanPath(scanPath);
  const config = await readConfig(projectPath);
  const detected = await detectLanguages(resolvedPath);
  return { resolvedPath, config, langs: detected.languages };
}

/**
 * Filter rules to the given categories. Returns all rules if categories is empty/absent.
 * @param {object[]} rules
 * @param {string[]|undefined} categories
 * @returns {object[]}
 */
function filterRulesByCategory(rules, categories) {
  if (!categories || categories.length === 0) return rules;
  return rules.filter((r) => categories.includes(r.category));
}

/**
 * Register the 7 focused scan tools on the given McpServer instance.
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {string} projectPath
 */
export function registerFocusedScanTools(server, projectPath) {
  server.registerTool(
    "scan_duplicates",
    {
      description:
        "Scan a directory for duplicate code blocks. Returns raw results without persisting. Use run_scan to persist findings.",
      inputSchema: z.object({
        path: z.string().describe("Directory to scan"),
        minTokens: z.number().optional().describe("Minimum token window size (default 100)"),
        similarity: z.number().optional().describe("Minimum similarity ratio 0–1 (default 0.80)"),
        minConfidence: z
          .number()
          .optional()
          .describe(
            "Minimum confidence 0–1 to include a finding (default 0.5). Lower values surface more results including data-structure repetition.",
          ),
        excludeTests: z
          .boolean()
          .optional()
          .describe("Exclude test files from scanning (default true)"),
      }),
    },
    async ({ path: scanPath, minTokens, similarity, minConfidence, excludeTests }) => {
      try {
        const resolvedPath = await validateScanPath(scanPath);
        const config = await readConfig(projectPath);
        const findings = await scanDuplicates(resolvedPath, {
          minTokens,
          similarity,
          minConfidence,
          excludeTests,
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
        const { resolvedPath, config, langs } = await resolveScanContext(scanPath, projectPath);
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
        const { resolvedPath, config, langs } = await resolveScanContext(scanPath, projectPath);
        const mergedThresholds = { ...config.thresholds, ...(thresholds ?? {}) };
        const result = await computeMetrics(resolvedPath, {
          ...mergedThresholds,
          languages: langs,
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
        const { resolvedPath, config, langs } = await resolveScanContext(scanPath, projectPath);
        const rules = filterRulesByCategory(buildRules(langs), categories);
        const findings = await scanPatterns(resolvedPath, rules, {
          exclude: config.exclude,
          languages: langs,
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
        const { resolvedPath, config, langs } = await resolveScanContext(scanPath, projectPath);
        const findings = await scanInconsistentPatterns(resolvedPath, {
          exclude: config.exclude,
          languages: langs,
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
        const { resolvedPath, config, langs } = await resolveScanContext(scanPath, projectPath);
        const findings = await scanOverEngineering(resolvedPath, {
          exclude: config.exclude,
          languages: langs,
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
}
