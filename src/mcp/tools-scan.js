/**
 * run_scan tool registration for the lazy-refactor MCP server.
 *
 * This tool orchestrates all scan engines, scores findings, and persists them.
 * Individual focused scan tools (scan_duplicates, scan_dead_code, etc.) are in
 * tools-scan-focused.js.
 */

import * as z from "zod";
import {
  scanDeadCode,
  scanDivergentExports,
  scanUnusedDeps,
  scanUnusedImports,
} from "../engine/cross-ref.js";
import { detectLanguages } from "../engine/detect.js";
import { scanDuplicates } from "../engine/duplicates.js";
import { clearFileCache, collectFiles, LANGUAGE_EXTENSIONS } from "../engine/files.js";
import { configureGitignore } from "../engine/gitignore.js";
import { computeMetrics } from "../engine/metrics.js";
import { checkOutdatedDeps } from "../engine/outdated.js";
import { scanPatterns } from "../engine/pattern-scanner.js";
import { scanInconsistentPatterns, scanOverEngineering } from "../engine/patterns.js";
import { scanToctou } from "../engine/toctou.js";
import { scoreFindings } from "../scoring/prioritizer.js";
import { addFindings, getSummary } from "../state/findings.js";
import { createRun, getRun, setActiveRun } from "../state/runs.js";
import { buildRules, fail, ok, readConfig, validateScanPath } from "./helpers.js";
import {
  mapCluster,
  mapDeadExport,
  mapDivergentExport,
  mapDupe,
  mapInconsistent,
  mapMetric,
  mapOverEngineering,
  mapPattern,
  mapToctou,
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
    return validateLanguages(langOverride);
  }
  if (config.languages !== "auto") {
    return validateLanguages(
      Array.isArray(config.languages) ? config.languages : [config.languages],
    );
  }
  const detected = await detectLanguages(resolvedPath);
  return detected.languages;
}

/**
 * Validate explicitly-supplied languages against the known set so a typo or
 * unsupported language fails loudly instead of silently scanning nothing.
 * @param {string[]} languages
 * @returns {string[]}
 */
function validateLanguages(languages) {
  const known = Object.keys(LANGUAGE_EXTENSIONS).filter((k) => k !== "common");
  const bad = languages.filter((l) => !known.includes(l));
  if (bad.length > 0) {
    throw new Error(
      `Unknown language(s) in 'languages': ${bad.join(", ")}. Known: ${known.join(", ")}`,
    );
  }
  return languages;
}

/**
 * Remove findings whose check is listed in config.disabledChecks.
 * @param {object[]} findings
 * @param {object} config
 * @returns {object[]}
 */
function filterDisabledChecks(findings, config) {
  const disabled = Array.isArray(config.disabledChecks) ? config.disabledChecks : [];
  if (disabled.length === 0) {
    return findings;
  }
  return findings.filter((f) => !disabled.includes(f.check));
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
  const tasks = [];

  // One representative walk up front: it pre-populates collectFiles' cache (which the
  // engine scans below reuse) AND captures any directory hidden by a permission/IO
  // error, so a scan can't silently miss a protected subtree and still report success.
  const skipped = [];
  await collectFiles(resolvedPath, { exclude, languages, skipped });

  if (focus.includes("duplicates")) {
    tasks.push(
      scanDuplicates(resolvedPath, {
        minTokens: config.thresholds.duplicateMinTokens,
        similarity: config.thresholds.duplicateSimilarity,
        exclude,
        languages,
      }).then((dupes) =>
        dupes.map((f) =>
          f.check === "duplicate-cluster" ? mapCluster(f, resolvedPath) : mapDupe(f, resolvedPath),
        ),
      ),
    );
  }

  if (focus.includes("dead-code")) {
    tasks.push(
      Promise.all([
        scanDeadCode(resolvedPath, {}, { exclude, languages }),
        scanUnusedDeps(resolvedPath, { exclude }),
        scanUnusedImports(resolvedPath, { exclude, languages }),
        scanDivergentExports(resolvedPath, { exclude, languages }),
      ]).then(([dead, unusedDeps, unusedImports, divergent]) => [
        ...dead.map((f) => mapDeadExport(f, resolvedPath)),
        ...unusedDeps.map((f) => mapUnusedDep(f)),
        ...unusedImports.map((f) => mapUnusedImport(f, resolvedPath)),
        ...divergent.map((f) => mapDivergentExport(f, resolvedPath)),
      ]),
    );
  }

  if (focus.includes("metrics")) {
    tasks.push(
      computeMetrics(resolvedPath, {
        maxFileLines: config.thresholds.maxFileLines,
        maxComplexity: config.thresholds.maxComplexity,
        maxNesting: config.thresholds.maxNesting,
        maxExportsPerFile: config.thresholds.maxExportsPerFile,
        maxImportsPerFile: config.thresholds.maxImportsPerFile,
        languages,
        exclude,
      }).then(({ findings: metricFindings }) => metricFindings.map((f) => mapMetric(f))),
    );
  }

  if (focus.includes("patterns")) {
    tasks.push(
      scanPatterns(resolvedPath, rules, { exclude, languages }).then((pf) =>
        pf.map((f) => mapPattern(f)),
      ),
    );
    tasks.push(
      scanToctou(resolvedPath, { exclude, languages }).then((tf) =>
        tf.map((f) => mapToctou(f, resolvedPath)),
      ),
    );
  }

  if (focus.includes("inconsistent-patterns")) {
    tasks.push(
      scanInconsistentPatterns(resolvedPath, { exclude, languages }).then((ifs) =>
        ifs.map((f) => mapInconsistent(f, resolvedPath)),
      ),
    );
  }

  if (focus.includes("over-engineering")) {
    tasks.push(
      scanOverEngineering(resolvedPath, { exclude, languages }).then((oefs) =>
        oefs.map((f) => mapOverEngineering(f, resolvedPath)),
      ),
    );
  }

  if (focus.includes("outdated")) {
    tasks.push(checkOutdatedDeps(resolvedPath, languages));
  }

  const settled = await Promise.allSettled(tasks);
  const allFindings = [];
  const warnings = [];
  for (const result of settled) {
    if (result.status === "fulfilled") {
      allFindings.push(...result.value);
    } else {
      warnings.push(result.reason?.message ?? String(result.reason));
    }
  }
  if (skipped.length > 0) {
    const paths = skipped.map((s) => `${s.path} (${s.code})`).join(", ");
    warnings.push(
      `${skipped.length} path(s) were unreadable and skipped — results may be incomplete: ${paths}`,
    );
  }
  if (warnings.length > 0) {
    allFindings.warnings = warnings;
  }
  return allFindings;
}

const DEFAULT_FOCUS = [
  "duplicates",
  "dead-code",
  "metrics",
  "patterns",
  "inconsistent-patterns",
  "over-engineering",
  "outdated",
];

const scanOptionsSchema = z
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
  .optional();

/**
 * Scan `scanPath` into the ACTIVE run (merging/stale-marking, preserving prior
 * triage edits), then return the scan result. The caller decides which run is
 * active (run_scan creates a new one; resume_scan re-activates an existing one).
 */
async function performScan(projectPath, scanPath, options) {
  const resolvedPath = await validateScanPath(scanPath);
  const config = await readConfig(projectPath);
  const focus = options.focus ?? DEFAULT_FOCUS;
  const exclude = [...config.exclude, ...(options.exclude ?? [])];
  const languages = await resolveLanguages(config, options.languages, resolvedPath);
  // Applies to every collectFiles call under this scan root (the chokepoint
  // reads it), so no need to thread a flag through each scanner.
  configureGitignore(resolvedPath, config.respectGitignore !== false);

  clearFileCache();
  const allFindings = await collectFindings(resolvedPath, focus, config, languages, exclude);
  const engineWarnings = allFindings.warnings;
  const scored = scoreFindings(filterDisabledChecks(allFindings, config));

  const scanId = `scan-${Date.now()}`;
  // addFindings records scanId/path on the active run row and bumps updated_at.
  await addFindings(projectPath, scored, scanId, resolvedPath);

  const result = { scanId, totalFindings: scored.length, summary: await getSummary(projectPath) };
  if (engineWarnings?.length > 0) result.warnings = engineWarnings;
  return result;
}

/**
 * Register the run_scan and resume_scan tools on the given McpServer instance.
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {string} projectPath
 */
export function registerRunScan(server, projectPath) {
  server.registerTool(
    "run_scan",
    {
      description:
        "Scan a directory into a NEW run (new ID), score findings, and persist them. " +
        "Previous runs are preserved — nothing is purged. Returns { runId, scanId, ... }.",
      inputSchema: z.object({
        path: z.string().describe("Directory to scan"),
        options: scanOptionsSchema,
      }),
    },
    async ({ path: scanPath, options = {} }) => {
      try {
        const run = createRun(projectPath, {});
        return ok({ runId: run.id, ...(await performScan(projectPath, scanPath, options)) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "resume_scan",
    {
      description:
        "Re-activate an existing run by ID and re-scan into it, merging results while " +
        "preserving your fixed/ignored edits. Uses the run's stored path unless overridden.",
      inputSchema: z.object({
        id: z.string().describe("Run ID to resume (see list_runs)"),
        path: z.string().optional().describe("Override the scan path (defaults to the run's path)"),
        options: scanOptionsSchema,
      }),
    },
    async ({ id, path, options = {} }) => {
      try {
        const run = getRun(projectPath, id);
        if (!run) {
          return fail(new Error(`Run '${id}' not found`));
        }
        const scanPath = path ?? run.path;
        if (!scanPath) {
          return fail(new Error(`Run '${id}' has no stored scan path; provide 'path'.`));
        }
        const resolvedPath = await validateScanPath(scanPath);
        setActiveRun(projectPath, id);
        return ok({ runId: id, ...(await performScan(projectPath, resolvedPath, options)) });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
