# lazy-refactor — Reference Architecture

This document describes the lazy-dev plugin architecture that lazy-refactor should follow. lazy-dev is the reference implementation for how Claude Code plugins work in this series.

---

## Claude Code Plugin Structure

A Claude Code plugin is a directory containing:

```
.claude-plugin/
  manifest.json          — declares the plugin name, MCP server, agents, commands, hooks

agents/                  — markdown files defining subagent system prompts
commands/                — markdown files defining slash commands
hooks/                   — shell scripts triggered by Claude Code events
src/                     — source code (MCP server, business logic)
```

### manifest.json

```json
{
  "name": "lazy-refactor",
  "description": "Code quality and maintainability scanner with automated fixes",
  "mcpServers": {
    "lazy-refactor": {
      "command": "bun",
      "args": ["run", "src/mcp/server.js"],
      "env": {}
    }
  }
}
```

### MCP Server

The MCP server is a Bun/JS process that exposes tools via the Model Context Protocol. It uses the `@modelcontextprotocol/sdk` package (or the server can be built with raw JSON-RPC over stdio — check what lazy-dev uses).

Tools are functions that Claude can call. They should:
- Return structured JSON results
- Handle errors gracefully (return error info, don't crash)
- Be stateless where possible (state lives in the findings JSON file)

### Agents

Agent markdown files contain frontmatter + system prompt:

```markdown
---
name: fixer
description: Makes targeted refactoring changes with test verification
model: sonnet
effort: medium
---

You are a code refactoring specialist. Your job is to...
```

The `model` and `effort` fields control which Claude model and reasoning effort the agent uses. Follow lazy-dev's conventions for these.

### Commands

Command markdown files define slash commands the user can invoke:

```markdown
---
name: scan
description: Scan codebase for quality issues
---

Run a comprehensive code quality scan...
```

Commands are invoked as `/lazy-refactor scan [args]`.

---

## lazy-dev Architecture Reference

lazy-dev follows this structure (for reference — lazy-refactor should follow the same patterns):

```
.claude-plugin/          — plugin manifest
agents/                  — agent definitions (frontmatter + system prompt)
commands/                — slash commands (run, status, cancel)
hooks/                   — SubagentStop hook (ralph-gate.sh -> gate.js)
src/mcp/                 — MCP server + tool wrappers
src/orchestrator/        — dispatch, scheduling, validation, merge, review
src/ralph/               — gate algorithm, sentinel parser, state, verifiers, usage
src/shared/              — shared utilities (verdict parser)
```

Key patterns from lazy-dev:

1. **MCP server provides tools** — agents call these tools to do work
2. **State is stored as JSON files** — under a `tasks/` directory (lazy-refactor would use `.lazy-refactor/`)
3. **Agents are specialists** — each agent has a clear, narrow responsibility
4. **The orchestrator coordinates** — dispatches agents, tracks state, manages the pipeline
5. **Quality verification** — lazy-dev uses ralph-gate to verify agent output. lazy-refactor uses the test suite.

---

## How lazy-refactor Maps to This Architecture

```
lazy-refactor/
├── .claude-plugin/
│   └── manifest.json
├── agents/
│   ├── scanner.md             — runs deterministic analysis + AI assessment
│   ├── fixer.md               — makes changes, runs tests, rollbacks on failure
│   └── assessor.md            — deep AI analysis for ambiguous findings
├── commands/
│   ├── scan.md                — /lazy-refactor scan
│   ├── report.md              — /lazy-refactor report
│   ├── fix.md                 — /lazy-refactor fix
│   └── status.md              — /lazy-refactor status
├── src/
│   ├── mcp/
│   │   └── server.js          — MCP server exposing tools
│   ├── engine/
│   │   ├── pattern-scanner.js — regex/grep pattern matching
│   │   ├── metrics.js         — file-level metrics computation
│   │   ├── cross-ref.js       — export/import graph analysis
│   │   └── duplicates.js      — Rabin-Karp token hashing
│   ├── rules/
│   │   ├── common.js
│   │   ├── typescript.js
│   │   ├── go.js
│   │   ├── python.js
│   │   ├── csharp.js
│   │   ├── java.js
│   │   └── outdated-patterns.js
│   ├── scoring/
│   │   └── prioritizer.js
│   └── state/
│       └── findings.js
├── package.json
└── biome.json
```

### MCP Tool Inventory

**Scan tools** (called by scanner agent):
- `run_scan(path, options)` — orchestrates all analysers, returns raw findings
- `scan_duplicates(path, minTokens, threshold)` — Rabin-Karp duplicate detection
- `scan_dead_code(path)` — export/import cross-reference analysis
- `scan_metrics(path, thresholds)` — file-level metrics (size, complexity, ratios)
- `scan_patterns(path, categories)` — regex pattern matching against rule files
- `detect_language(path)` — auto-detect project language(s)

**State tools** (called by all agents and commands):
- `get_findings(filter)` — retrieve findings with optional filter (severity, category, status)
- `get_finding(id)` — single finding detail
- `update_finding(id, status, notes)` — mark as fixed/ignored/in-progress/false-positive
- `get_summary()` — aggregate statistics

**Config tools:**
- `get_config()` — current settings
- `update_config(overrides)` — adjust thresholds

### Data Flow

```
User: /lazy-refactor scan src/
  │
  ├─→ scan command dispatches scanner agent
  │
  ├─→ scanner agent calls MCP scan tools:
  │     scan_metrics(src/) → file sizes, complexity scores
  │     scan_dead_code(src/) → orphaned exports, unused deps
  │     scan_duplicates(src/) → clone groups
  │     scan_patterns(src/, all) → pattern rule matches
  │
  ├─→ scanner agent does AI assessment on flagged items:
  │     "Are these 3 files really god files? What concerns do they mix?"
  │     "Is this abstraction genuinely over-engineered?"
  │     "What's the canonical pattern among these 4 variants?"
  │
  ├─→ findings stored via MCP state tools
  │
  └─→ summary presented to user

User: /lazy-refactor fix 3
  │
  ├─→ fix command reads finding #3 from state
  │
  ├─→ dispatches fixer agent with finding context
  │
  ├─→ fixer agent:
  │     reads the relevant source files
  │     makes targeted changes
  │     runs test suite (auto-detected: bun test / go test / pytest / etc.)
  │     tests pass → marks finding as fixed
  │     tests fail → reverts changes, reports failure
  │
  └─→ result presented to user
```
