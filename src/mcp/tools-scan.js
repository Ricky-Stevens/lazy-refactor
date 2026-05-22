/**
 * run_scan tool registration for the lazy-refactor MCP server.
 *
 * This tool orchestrates all scan engines, scores findings, and persists them.
 * Individual focused scan tools (scan_duplicates, scan_dead_code, etc.) are in
 * tools-scan-focused.js.
 */

import * as z from "zod";
import { scanDeadCode, scanUnusedDeps, scanUnusedImports } from "../engine/cross-ref.js";
import { detectLanguages } from "../engine/detect.js";
import { scanDuplicates } from "../engine/duplicates.js";
import { computeMetrics } from "../engine/metrics.js";
import { checkOutdatedDeps } from "../engine/outdated.js";
import { scanPatterns } from "../engine/pattern-scanner.js";
import { scanInconsistentPatterns, scanOverEngineering } from "../engine/patterns.js";
import { scoreFindings } from "../scoring/prioritizer.js";
import { addFindings, getSummary } from "../state/findings.js";
import { buildRules, fail, ok, readConfig, validateScanPath } from "./helpers.js";
import {
  mapCluster,
  mapDeadExport,
  mapDupe,
  mapInconsistent,
  mapMetric,
  mapOverEngineering,
  mapPattern,
  mapUnusedDep,
  mapUnusedImport,
} from "./mappers.js";

/**
 * Resolve the languages to scan based on config, an optional override, and auto-detection.
 * @param {object} config
 * @param {string[]|undefined} langOverride
 * @param {string} resolvedPath
 * @returns {Promise<string[]>}
 */
async function resolveLanguages(config, langOverride, resolvedPath) {
  if (langOverride && langOverride.length > 0) {
    return langOverride;
  }
  if (config.languages !== "auto") {
    return Array.isArray(config.languages) ? config.languages : [config.languages];
  }
  const detected = await detectLanguages(resolvedPath);
  return detected.languages;
}

/**
 * Remove findings whose check is listed in config.disabledChecks.
 * @param {object[]} findings
 * @param {object} config
 * @returns {object[]}
 */
function filterDisabledChecks(findings, config) {
  if (!config.disabledChecks || config.disabledChecks.length === 0) {
    return findings;
  }
  return findings.filter((f) => !config.disabledChecks.includes(f.check));
}

/**
 * Collect findings from all requested scan engines.
 * @param {string} resolvedPath
 * @param {string[]} focus
 * @param {object} config
 * @param {string[]} languages
 * @param {string[]} exclude
 * @returns {Promise<object[]>}
 */
async function collectFindings(resolvedPath, focus, config, languages, exclude) {
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
      ...dupes.map((f) => (f.check === "duplicate-cluster" ? mapCluster(f) : mapDupe(f))),
    );
  }

  if (focus.includes("dead-code")) {
    const dead = await scanDeadCode(resolvedPath, {}, { exclude, languages });
    allFindings.push(...dead.map((f) => mapDeadExport(f, resolvedPath)));

    const unusedDeps = await scanUnusedDeps(resolvedPath, { exclude });
    allFindings.push(...unusedDeps.map((f) => mapUnusedDep(f)));

    const unusedImports = await scanUnusedImports(resolvedPath, { exclude, languages });
    allFindings.push(...unusedImports.map((f) => mapUnusedImport(f, resolvedPath)));
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
    allFindings.push(...metricFindings.map((f) => mapMetric(f)));
  }

  if (focus.includes("patterns")) {
    const patternFindings = await scanPatterns(resolvedPath, rules, { exclude, languages });
    allFindings.push(...patternFindings.map((f) => mapPattern(f)));
  }

  if (focus.includes("inconsistent-patterns")) {
    const inconsistentFindings = await scanInconsistentPatterns(resolvedPath, {
      exclude,
      languages,
    });
    allFindings.push(...inconsistentFindings.map((f) => mapInconsistent(f, resolvedPath)));
  }

  if (focus.includes("over-engineering")) {
    const overEngFindings = await scanOverEngineering(resolvedPath, { exclude, languages });
    allFindings.push(...overEngFindings.map((f) => mapOverEngineering(f, resolvedPath)));
  }

  if (focus.includes("outdated")) {
    const outdatedFindings = await checkOutdatedDeps(resolvedPath, languages);
    allFindings.push(...outdatedFindings);
  }

  return allFindings;
}

/**
 * Register the run_scan tool on the given McpServer instance.
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {string} projectPath
 */
export function registerRunScan(server, projectPath) {
  server.registerTool(
    "run_scan",
    {
      description:
        "Run all (or a focused subset of) scan engines, score findings, and persist them.",
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
        const languages = await resolveLanguages(config, options.languages, resolvedPath);

        const allFindings = await collectFindings(resolvedPath, focus, config, languages, exclude);
        const filtered = filterDisabledChecks(allFindings, config);
        const scored = scoreFindings(filtered);

        const scanId = `scan-${Date.now()}`;
        await addFindings(projectPath, scored, scanId, resolvedPath);

        const summary = await getSummary(projectPath);
        return ok({ scanId, totalFindings: scored.length, summary });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
