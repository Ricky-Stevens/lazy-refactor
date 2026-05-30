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

function makeUpdateConfigHandler(projectPath) {
  return async ({ overrides }) => {
    try {
      const current = await readConfig(projectPath);
      const updated = deepMerge(current, overrides);
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
