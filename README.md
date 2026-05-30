# lazy-refactor

[![CI](https://github.com/Ricky-Stevens/lazy-refactor/actions/workflows/ci.yml/badge.svg)](https://github.com/Ricky-Stevens/lazy-refactor/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/Ricky-Stevens/lazy-refactor/graph/badge.svg)](https://codecov.io/gh/Ricky-Stevens/lazy-refactor)
[![Semgrep](https://img.shields.io/badge/security-semgrep-blue)](https://github.com/Ricky-Stevens/lazy-refactor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![version](https://img.shields.io/badge/version-0.6.0-blue)](https://github.com/Ricky-Stevens/lazy-refactor/releases)
[![Bun](https://img.shields.io/badge/runtime-Bun%201.3%2B-f9f1e1)](https://bun.sh)

Code with AI at full speed. Clean up after it automatically.

lazy-refactor is a Claude Code plugin that finds and fixes the mess AI-generated code leaves behind -- copy-pasted logic, dead exports, bloated files, inconsistent patterns, deprecated APIs. It scans deterministically (zero LLM tokens), then an AI fixer agent extracts shared functions, removes dead code, and verifies every change with tests.

## Install

```bash
/plugin marketplace add https://github.com/Ricky-Stevens/lazy-refactor
/plugin install lazy-refactor
```

**Note:** Claude's `/reload-plugins` can be a bit sketchy - try opening a new session if you hit issues.

### Update

To pull the latest version:

1. Open `/plugins`
2. Go to **Marketplaces** tab → select the lazy-refactor marketplace → **Update marketplace**
3. Inside the marketplace, go to **Browse Plugins** → select lazy-refactor → **Update**
4. Run `/reload-plugins` or restart your session

### Uninstall

```bash
/plugin uninstall lazy-refactor
```

### Local development

```bash
claude --plugin-dir /path/to/lazy-refactor
```

---

## The problem

AI coding assistants are fast but sloppy. They generate working code by completing patterns, not by thinking about architecture. The result:

- The same error-handling block copy-pasted into 8 files instead of a shared utility
- Functions independently reimplemented across modules because the AI didn't know a shared version existed
- Dead exports and unused imports accumulating as the AI rewrites sections without cleaning up
- File complexity creeping past maintainable thresholds as the AI bolts on features
- Inconsistent approaches to the same concern across different parts of the codebase

This is fine while you're moving fast. It's not fine when you need to maintain it.

## How it works

**Scan** -- deterministic analysis with zero LLM cost. Pattern matching, metrics, Rabin-Karp duplicate detection with structural-entropy scoring, cross-reference analysis for dead code. Findings are scored by confidence and impact so you fix what matters first.

**Fix** -- an AI fixer agent reads each finding, understands the context, makes the minimal extraction or cleanup, runs your test suite, and rolls back if anything breaks. For duplicate code, it classifies the refactoring strategy automatically:

| Category | What the AI found | What the fixer does |
|---|---|---|
| `extract-and-share` | Same function written independently in multiple files | Moves to shared module, updates imports |
| `extract-wrapper` | Repeated try/catch or setup/teardown pattern | Extracts higher-order wrapper function |
| `extract-function` | Inline logic block duplicated across call sites | Extracts named function, replaces both sites |
| `extract-config` | Repeated data structures or configuration | Extracts shared constant or factory |

Every fix is verified by your existing test suite. No fix ships without passing tests.

## Quick start

```
/lazy-refactor:scan .
/lazy-refactor:report
/lazy-refactor:fix all
```

### Slash commands

| Command | Description |
|---|---|
| `/lazy-refactor:scan [path]` | Scan the codebase for quality issues |
| `/lazy-refactor:fix <id\|all\|critical\|high>` | Fix findings (bulk targets filter by `fixable: true`) |
| `/lazy-refactor:report [--severity=high] [--language=go]` | Show findings from last scan |
| `/lazy-refactor:status` | Show current scan and fix state |

### MCP Tools (23)

**Scan:** `run_scan`, `resume_scan`, `scan_duplicates`, `scan_dead_code`, `scan_metrics`, `scan_patterns`, `scan_inconsistent_patterns`, `scan_over_engineering`, `detect_language`

**Runs:** `list_runs`, `set_active_run`, `set_run_status`, `delete_run`

**State:** `get_findings`, `get_findings_by_ids`, `count_findings`, `get_summary`, `update_finding`, `update_findings`, `prune_findings`, `clear_findings`

**Config:** `get_config`, `update_config`

Each `run_scan` creates a new **run** (its own findings + triage state); previous runs are preserved. `list_runs` shows them (most recent first, active one marked; archived runs hidden). `set_active_run <id>` switches to a prior run without re-scanning, `resume_scan <id>` re-scans into one, and `delete_run <id>` removes it. The active run persists across sessions, so triage resumes where you left off.

## What it catches

- **Duplicate logic** -- Rabin-Karp token matching with confidence scoring that distinguishes real copy-paste from structural repetition (config arrays, rule definitions). Includes source snippets and refactoring category hints so the fixer acts immediately.
- **Dead code** -- unused exports, orphan dependencies, unused imports via cross-reference analysis with framework-aware entry points
- **Complexity** -- file size, nesting depth, cyclomatic complexity, export/import counts with language-aware thresholds
- **Anti-patterns** -- 60+ regex rules across 5 languages: error handling gaps, debugging leftovers, security issues, deprecated APIs
- **Inconsistent patterns** -- different approaches to the same concern across the codebase
- **Over-engineering** -- unnecessary abstractions, pass-through wrappers, low-fan-in indirection
- **Outdated dependencies** -- deprecated API detection with specific migration paths (moment to dayjs, ioutil to io, javax to jakarta)

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
    "duplicateMinTokens": 100,
    "duplicateSimilarity": 0.80
  },
  "exclude": ["vendor/**", "generated/**", "*.generated.*", "node_modules/**", ".git/**"],
  "disabledChecks": [],
  "languages": "auto"
}
```

## Supported languages

| Language | Patterns | Metrics | Duplicates | Dead code | Notes |
|---|---|---|---|---|---|
| TypeScript/JavaScript | Full | Full | Full | Full | Primary target |
| Go | Full | Full | Full | Full | Go-aware metrics and grep-based cross-ref |
| Python | Full | Full | Full | Full | Indent-aware nesting, decorator-aware scoring |
| C# | Full | Full | Full | Partial | Namespace `using` limits cross-ref confidence |
| Java | Full | Full | Full | Full | javax-to-jakarta migration support |

## Development

Requires [Bun](https://bun.sh) v1.3+.

```bash
bun install
bun test          # run all tests
bun run lint      # biome check
bun run format    # biome format
```

## License

[MIT](LICENSE)
