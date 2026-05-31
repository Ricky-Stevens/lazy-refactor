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
import { clearFileCache } from "../engine/files.js";
import { configureGitignore } from "../engine/gitignore.js";
import { computeMetrics } from "../engine/metrics.js";
import { scanPatterns } from "../engine/pattern-scanner.js";
import { scanInconsistentPatterns, scanOverEngineering } from "../engine/patterns.js";
import { buildRules, effectiveExclude, fail, ok, readConfig, validateScanPath } from "./helpers.js";

const DEFAULT_SCAN_LIMIT = 200;

// Pagination + projection fields shared by every focused scan tool. Without these a
// single scan_patterns/scan_duplicates call can emit thousands of snippet-laden
// findings into the model's context at once (the "dump to disk and jq it" vector).
const pageShape = {
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Max findings to return (default ${DEFAULT_SCAN_LIMIT}).`),
  offset: z.number().int().min(0).optional().describe("Number of findings to skip (default 0)."),
  compact: z
    .boolean()
    .optional()
    .describe("Drop bulky fields (e.g. code snippets) from each returned finding."),
};

/** Strip bulky fields (code snippets) from a finding for compact responses. */
export function compactFinding(f) {
  if (!f || typeof f !== "object") return f;
  const { snippet, ...rest } = f;
  return rest;
}

/**
 * Slice a findings array to one page and project it, returning an envelope that
 * mirrors get_findings ({ findings, total, offset, limit, truncated }) so callers
 * can page deterministically instead of pulling an unbounded result in one shot.
 */
export function boundFindings(items, { limit, offset, compact } = {}) {
  const all = Array.isArray(items) ? items : [];
  const off = Math.max(0, offset ?? 0);
  const lim = Math.max(0, limit ?? DEFAULT_SCAN_LIMIT);
  const page = all.slice(off, off + lim);
  return {
    findings: compact ? page.map(compactFinding) : page,
    total: all.length,
    offset: off,
    limit: lim,
    truncated: all.length > off + lim,
  };
}

/**
 * Resolve scan path, config, and detected languages in one call.
 * @param {string} scanPath
 * @param {string} projectPath
 * @returns {{ resolvedPath: string, config: object, langs: string[], exclude: string[] }}
 */
async function resolveScanContext(scanPath, projectPath) {
  const resolvedPath = await validateScanPath(scanPath);
  const config = await readConfig(projectPath);
  configureGitignore(resolvedPath, config.respectGitignore !== false);
  clearFileCache();
  const detected = await detectLanguages(resolvedPath);
  // `exclude` already folds in the user-curated `ignore` list, so every focused
  // scan honours it without each handler re-composing the set.
  return { resolvedPath, config, langs: detected.languages, exclude: effectiveExclude(config) };
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

function registerSimpleScanTool(server, projectPath, name, description, scanFn) {
  server.registerTool(
    name,
    {
      description,
      inputSchema: z.object({ path: z.string().describe("Directory to scan"), ...pageShape }),
    },
    async ({ path: scanPath, limit, offset, compact }) => {
      try {
        const { resolvedPath, langs, exclude } = await resolveScanContext(scanPath, projectPath);
        const findings = await scanFn(resolvedPath, { exclude, languages: langs });
        return ok(boundFindings(findings, { limit, offset, compact }));
      } catch (err) {
        return fail(err);
      }
    },
  );
}

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
        ...pageShape,
      }),
    },
    async ({ path: scanPath, minTokens, similarity, minConfidence, excludeTests, ...page }) => {
      try {
        const resolvedPath = await validateScanPath(scanPath);
        const config = await readConfig(projectPath);
        configureGitignore(resolvedPath, config.respectGitignore !== false);
        clearFileCache();
        const findings = await scanDuplicates(resolvedPath, {
          minTokens,
          similarity,
          minConfidence,
          excludeTests,
          exclude: effectiveExclude(config),
        });
        return ok(boundFindings(findings, page));
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
        ...pageShape,
      }),
    },
    async ({ path: scanPath, limit, offset, compact }) => {
      try {
        const { resolvedPath, langs, exclude } = await resolveScanContext(scanPath, projectPath);
        const [dead, unusedDeps, unusedImports] = await Promise.all([
          scanDeadCode(resolvedPath, {}, { exclude, languages: langs }),
          scanUnusedDeps(resolvedPath, { exclude }),
          scanUnusedImports(resolvedPath, { exclude, languages: langs }),
        ]);
        // Each of the three lists is paged independently so no single sub-array can blow up.
        const dc = boundFindings(dead, { limit, offset, compact });
        const ud = boundFindings(unusedDeps, { limit, offset, compact });
        const ui = boundFindings(unusedImports, { limit, offset, compact });
        return ok({
          deadCode: dc.findings,
          unusedDeps: ud.findings,
          unusedImports: ui.findings,
          totals: { deadCode: dc.total, unusedDeps: ud.total, unusedImports: ui.total },
          offset: dc.offset,
          limit: dc.limit,
          truncated: dc.truncated || ud.truncated || ui.truncated,
        });
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
        ...pageShape,
      }),
    },
    async ({ path: scanPath, thresholds, limit, offset, compact }) => {
      try {
        const { resolvedPath, config, langs, exclude } = await resolveScanContext(
          scanPath,
          projectPath,
        );
        const mergedThresholds = { ...config.thresholds, ...(thresholds ?? {}) };
        const result = await computeMetrics(resolvedPath, {
          ...mergedThresholds,
          languages: langs,
          exclude,
        });
        // computeMetrics returns { fileMetrics, findings }. findings (threshold violations)
        // is the actionable list and is paged; fileMetrics is one entry per scanned file —
        // paged too, and omitted entirely under compact since it's secondary raw data.
        const f = boundFindings(result.findings, { limit, offset, compact });
        const fm = boundFindings(result.fileMetrics, { limit, offset, compact });
        return ok({
          findings: f.findings,
          fileMetrics: compact ? undefined : fm.findings,
          total: f.total,
          fileMetricsTotal: fm.total,
          offset: f.offset,
          limit: f.limit,
          truncated: f.truncated || (!compact && fm.truncated),
        });
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
        ...pageShape,
      }),
    },
    async ({ path: scanPath, categories, limit, offset, compact }) => {
      try {
        const { resolvedPath, langs, exclude } = await resolveScanContext(scanPath, projectPath);
        const rules = filterRulesByCategory(buildRules(langs), categories);
        const findings = await scanPatterns(resolvedPath, rules, {
          exclude,
          languages: langs,
        });
        return ok(boundFindings(findings, { limit, offset, compact }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerSimpleScanTool(
    server,
    projectPath,
    "scan_inconsistent_patterns",
    "Scan for inconsistent coding patterns across the codebase (Check 10). Returns raw results without persisting. Use run_scan to persist findings.",
    scanInconsistentPatterns,
  );

  registerSimpleScanTool(
    server,
    projectPath,
    "scan_over_engineering",
    "Scan for over-engineered abstractions and unnecessary complexity (Check 13). Returns raw results without persisting. Use run_scan to persist findings.",
    scanOverEngineering,
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
