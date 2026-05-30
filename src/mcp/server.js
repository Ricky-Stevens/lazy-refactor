/**
 * MCP server entry point for lazy-refactor.
 *
 * Exposes 23 tools:
 *   Scan:   run_scan, resume_scan, scan_duplicates, scan_dead_code, scan_metrics, scan_patterns,
 *           detect_language, scan_inconsistent_patterns, scan_over_engineering
 *   Runs:   list_runs, set_active_run, set_run_status, delete_run
 *   State:  get_findings, get_findings_by_ids, count_findings, get_summary, update_finding,
 *           update_findings, prune_findings, clear_findings
 *   Config: get_config, update_config
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { detectLanguages } from "../engine/detect.js";
import { checkOutdatedDeps } from "../engine/outdated.js";
import { closeAllConnections } from "../state/findings-store.js";
import { registerConfigTools } from "./tools-config.js";
import { registerRunTools } from "./tools-runs.js";
import { registerRunScan } from "./tools-scan.js";
import { registerFocusedScanTools } from "./tools-scan-focused.js";
import { registerStateTools } from "./tools-state.js";

const projectPath = process.cwd();

const server = new McpServer({
  name: "lazy-refactor",
  version: "0.6.0",
});

registerRunScan(server, projectPath);
registerFocusedScanTools(server, projectPath);
registerStateTools(server, projectPath);
registerRunTools(server, projectPath);
registerConfigTools(server, projectPath);

// Checkpoint and close the SQLite handle on shutdown so the WAL is folded back in
// and the -wal/-shm sidecars are not orphaned. `exit` covers normal termination,
// the fatal startup path below, and default crash exits; SIGINT/SIGTERM ensure a
// prompt exit. closeAllConnections is idempotent, so overlapping paths are safe.
process.on("exit", () => closeAllConnections());
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => process.exit(0));
}

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
