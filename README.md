# lazy-refactor

[![CI](https://github.com/Ricky-Stevens/lazy-refactor/actions/workflows/ci.yml/badge.svg)](https://github.com/Ricky-Stevens/lazy-refactor/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/Ricky-Stevens/lazy-refactor/graph/badge.svg)](https://codecov.io/gh/Ricky-Stevens/lazy-refactor)
[![Semgrep](https://img.shields.io/badge/security-semgrep-blue)](https://github.com/Ricky-Stevens/lazy-refactor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![version](https://img.shields.io/badge/version-0.1.0-blue)](https://github.com/Ricky-Stevens/lazy-refactor/releases)
[![Bun](https://img.shields.io/badge/runtime-Bun%201.3%2B-f9f1e1)](https://bun.sh)

A Claude Code plugin for deterministic code quality scanning with AI-powered fixes. Point it at a codebase — it finds the problems, scores them, and an AI agent fixes the easy ones while you focus on the hard ones.

## What it does

Scans codebases for quality issues using regex-based pattern matching, AST-free metrics, duplicate detection (Rabin-Karp), and cross-reference analysis. Findings are scored, persisted, and fixable via an AI agent that edits code and verifies with tests.

**Key capabilities:**
- **Pattern scanning** -- 60+ regex rules across 5 languages targeting error handling, debugging leftovers, security issues, deprecated APIs
- **Metrics** -- file complexity, nesting depth, export/import counts with language-aware counting
- **Duplicate detection** -- Rabin-Karp rolling hash with token normalization, intra-file and cross-file, cluster grouping
- **Dead code** -- cross-reference analysis of exports vs imports with framework-aware entry points
- **Outdated patterns** -- deprecated API detection with migration guidance (ioutil, moment.js, javax, etc.)
- **AI fixer** -- Claude reads findings, edits code, runs tests, rolls back on failure

## Install

Requires [Bun](https://bun.sh) v1.3+.

```bash
bun install
```

## Usage

This is a Claude Code MCP plugin. Install it by placing the `.claude-plugin/` directory in a project, or point Claude Code at the manifest.

### Slash commands

| Command | Description |
|---|---|
| `/lazy-refactor:scan [path]` | Run quality scans on the codebase |
| `/lazy-refactor:fix <id\|all\|critical\|high>` | Apply fixes (filters by `fixable: true` for bulk targets; ID bypasses filter) |
| `/lazy-refactor:report [--severity=high] [--language=go]` | Show findings from last scan |
| `/lazy-refactor:status` | Show current scan and fix state |

### MCP Tools (15)

**Scan:** `run_scan`, `scan_duplicates`, `scan_dead_code`, `scan_metrics`, `scan_patterns`, `scan_inconsistent_patterns`, `scan_over_engineering`, `detect_language`

**State:** `get_findings`, `get_finding`, `update_finding`, `clear_findings`, `get_summary`

**Config:** `get_config`, `update_config`

## Configuration

Create `.lazy-refactor.json` in the project root:

```json
{
  "thresholds": {
    "maxFileLines": 300,
    "maxComplexity": 15,
    "maxNesting": 4,
    "maxExportsPerFile": 10,
    "maxImportsPerFile": 15,
    "duplicateMinTokens": 50,
    "duplicateSimilarity": 0.80
  },
  "exclude": ["vendor/**", "generated/**", "*.generated.*", "node_modules/**", ".git/**"],
  "disabledChecks": [],
  "languages": "auto"
}
```

## Development

```bash
bun test          # run all tests
bun run lint      # biome check
bun run format    # biome format
```

## Supported Languages

| Language | Patterns | Metrics | Duplicates | Cross-ref / Dead Code | Notes |
|---|---|---|---|---|---|
| TypeScript/JavaScript | Full | Full | Full | Full | Primary language; highest coverage |
| Go | Full | Full (Go-aware counting) | Full | Full | Grep-based cross-referencing |
| Python | Full | Full (indent-aware) | Full | Full | Decorator-aware confidence scoring |
| C# | Full | Full | Full | Partial (confidence 0.7) | Grep-based cross-ref due to namespace `using` directives |
| Java | Full | Full | Full | Full | javax-to-jakarta migration support |

## Architecture

```
src/
  engine/         Deterministic analysis (no LLM calls)
    cross-ref.js    Dead code, unused imports, over-engineering
    duplicates.js   Rabin-Karp duplicate detection with clustering
    files.js        Shared file utilities (LANGUAGE_EXTENSIONS, collectFiles)
    metrics.js      Complexity, nesting, size metrics
    pattern-scanner.js  Regex pattern matching via ripgrep/grep
  mcp/
    server.js       MCP server entry point (15 tools)
  rules/            Pattern rule data files (one per language)
  scoring/          Finding prioritisation
  state/            JSON persistence for findings
agents/             AI agent prompts (scanner, fixer, assessor)
commands/           Slash command definitions
```

## License

[MIT](LICENSE)
