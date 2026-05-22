/**
 * MCP server entry point for lazy-refactor.
 *
 * Exposes 15 tools:
 *   Scan:   run_scan, scan_duplicates, scan_dead_code, scan_metrics, scan_patterns, detect_language,
 *           scan_inconsistent_patterns, scan_over_engineering
 *   State:  get_findings, get_finding, update_finding, get_summary, clear_findings
 *   Config: get_config, update_config
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { detectLanguages } from "../engine/detect.js";
import { checkOutdatedDeps } from "../engine/outdated.js";
import { registerRunScan } from "./tools-scan.js";
import { registerFocusedScanTools } from "./tools-scan-focused.js";
import { registerStateTools } from "./tools-state.js";

const projectPath = process.cwd();

const server = new McpServer({
  name: "lazy-refactor",
  version: "0.3.5",
});

registerRunScan(server, projectPath);
registerFocusedScanTools(server, projectPath);
registerStateTools(server, projectPath);

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
