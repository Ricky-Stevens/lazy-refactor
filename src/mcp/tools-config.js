/**
 * Config tool registrations for the lazy-refactor MCP server.
 *
 * Tools: get_config, update_config
 */

import { normalizeIgnoreEntry } from "../engine/ignore-list.js";
import { deepMerge, fail, ok, readConfig, writeConfig } from "./helpers.js";
import { emptySchema, ignoreUpdateSchema, overridesSchema } from "./tools-schemas.js";

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
  const { thresholds, exclude, disabledChecks, ignore, languages } = config;

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

  if (ignore !== undefined && !isStringArray(ignore)) {
    return "ignore must be an array of strings";
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

function makeGetIgnoreListHandler(projectPath) {
  return async () => {
    try {
      const config = await readConfig(projectPath);
      return ok({ ignore: config.ignore });
    } catch (err) {
      return fail(err);
    }
  };
}

/**
 * Apply add/remove edits to the ignore list. Existing entries keep their order;
 * removals are dropped; additions are appended. Everything is normalized (./ and
 * trailing / stripped) and de-duplicated so re-flagging the same path is a no-op.
 * @param {string[]} current
 * @param {string[]} add
 * @param {string[]} remove
 * @returns {string[]}
 */
function applyIgnoreEdits(current, add, remove) {
  const removeSet = new Set(remove.map(normalizeIgnoreEntry).filter(Boolean));
  const result = [];
  const seen = new Set();
  const push = (raw) => {
    const entry = normalizeIgnoreEntry(raw);
    if (entry === "" || removeSet.has(entry) || seen.has(entry)) return;
    seen.add(entry);
    result.push(entry);
  };
  for (const e of current) push(e);
  for (const e of add) push(e);
  return result;
}

function makeUpdateIgnoreListHandler(projectPath) {
  return async ({ add, remove }) => {
    try {
      const addList = Array.isArray(add) ? add : [];
      const removeList = Array.isArray(remove) ? remove : [];
      // Mutual-requirement validation lives here, not in a zod refine, so the MCP
      // inputSchema stays visible to clients.
      if (addList.length === 0 && removeList.length === 0) {
        return fail(new Error("update_ignore_list requires 'add' and/or 'remove'."));
      }
      if (![...addList, ...removeList].every((e) => typeof e === "string")) {
        return fail(new Error("'add' and 'remove' must be arrays of strings."));
      }
      const config = await readConfig(projectPath);
      const ignore = applyIgnoreEdits(config.ignore, addList, removeList);
      await writeConfig(projectPath, { ...config, ignore });
      return ok({ ignore });
    } catch (err) {
      return fail(err);
    }
  };
}

/**
 * Register the config + ignore-list tools on the given McpServer instance.
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

  server.registerTool(
    "get_ignore_list",
    {
      description:
        "Read the user-curated ignore list: project-relative files/dirs that scans permanently " +
        "skip, separate from .gitignore and the default exclude noise globs.",
      inputSchema: emptySchema,
    },
    makeGetIgnoreListHandler(projectPath),
  );

  server.registerTool(
    "update_ignore_list",
    {
      description:
        "Add and/or remove entries in the ignore list (.lazy-refactor.json `ignore`). Use this to " +
        "flag a file or directory — e.g. a seed or test script — so future scans skip it. A plain " +
        "path matches both a file and a directory's contents. Returns the resulting list.",
      inputSchema: ignoreUpdateSchema,
    },
    makeUpdateIgnoreListHandler(projectPath),
  );
}
