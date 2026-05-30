/**
 * Config tool registrations for the lazy-refactor MCP server.
 *
 * Tools: get_config, update_config
 */

import { deepMerge, fail, ok, readConfig, writeConfig } from "./helpers.js";
import { emptySchema, overridesSchema } from "./tools-schemas.js";

function makeGetConfigHandler(projectPath) {
  return async () => {
    try {
      return ok(await readConfig(projectPath));
    } catch (err) {
      return fail(err);
    }
  };
}

const THRESHOLD_KEYS = [
  "maxFileLines",
  "maxComplexity",
  "maxNesting",
  "maxExportsPerFile",
  "maxImportsPerFile",
  "duplicateMinTokens",
  "duplicateSimilarity",
];

const isStringArray = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * Validate the merged config shape before it reaches disk. Cross-field/shape
 * validation lives here (not in a zod refine) so the MCP inputSchema stays
 * visible to clients.
 * @param {Record<string, unknown>} config
 * @returns {string|null} An error message, or null if valid.
 */
function validateConfig(config) {
  const { thresholds, exclude, disabledChecks, languages } = config;

  if (thresholds !== undefined) {
    if (typeof thresholds !== "object" || thresholds === null || Array.isArray(thresholds)) {
      return "thresholds must be an object";
    }
    for (const key of THRESHOLD_KEYS) {
      const value = thresholds[key];
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
        return `thresholds.${key} must be a finite number`;
      }
    }
  }

  if (exclude !== undefined && !isStringArray(exclude)) {
    return "exclude must be an array of strings";
  }

  if (disabledChecks !== undefined && !isStringArray(disabledChecks)) {
    return "disabledChecks must be an array of strings";
  }

  if (languages !== undefined && languages !== "auto" && !isStringArray(languages)) {
    return "languages must be 'auto' or an array of strings";
  }

  return null;
}

function makeUpdateConfigHandler(projectPath) {
  return async ({ overrides }) => {
    try {
      const current = await readConfig(projectPath);
      const updated = deepMerge(current, overrides);
      const error = validateConfig(updated);
      if (error) {
        return fail(new Error(`Invalid config: ${error}`));
      }
      await writeConfig(projectPath, updated);
      return ok(updated);
    } catch (err) {
      return fail(err);
    }
  };
}

/**
 * Register the 2 config tools on the given McpServer instance.
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {string} projectPath
 */
export function registerConfigTools(server, projectPath) {
  server.registerTool(
    "get_config",
    { description: "Read project config, merged with defaults.", inputSchema: emptySchema },
    makeGetConfigHandler(projectPath),
  );

  server.registerTool(
    "update_config",
    {
      description: "Deep-merge overrides into project config and write .lazy-refactor.json.",
      inputSchema: overridesSchema,
    },
    makeUpdateConfigHandler(projectPath),
  );
}
