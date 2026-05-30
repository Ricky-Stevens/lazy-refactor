---
name: scan
description: Scan codebase for quality issues
---

# Scan Command

Scan the codebase for code quality issues using deterministic analysis and targeted AI assessment.

## Usage

```
/lazy-refactor scan [path] [--focus=duplicates,dead-code,...] [--exclude=pattern]
```

## Arguments

- `path` (optional): Directory or file to scan. Defaults to current working directory.
- `--focus` (optional): Comma-separated list of scan categories to focus on. Options: `duplicates`, `dead-code`, `metrics`, `patterns`, `inconsistent-patterns`, `over-engineering`, `outdated`. If omitted, all categories are scanned.
- `--exclude` (optional): Regex pattern for files/directories to exclude from the scan (e.g., `--exclude=node_modules|\.test\.ts`).

## Behavior

1. **Parse arguments**: Extract path, focus categories, and exclusion patterns.

2. **Dispatch the scanner agent**: Send the scan request to the scanner agent with:
   - The target path
   - Requested focus areas (or all if none specified)
   - Exclusion patterns to avoid scanning irrelevant code

3. **Collect results**: The scanner will:
   - Detect project languages
   - Run appropriate quality checks
   - Apply AI assessment to ambiguous findings
   - Persist findings to the findings store

4. **Handle errors**:
   - If the path does not exist, report an error
   - If no valid files are found in the path, report that no scannable files were found
   - If the scanner encounters an error, display the error details and advise the user

5. **Report output**: Display a summary of findings including:
   - The new run ID (each scan creates a new run)
   - Count of findings by severity and category
   - Brief summary of top issues
   - Instructions for viewing detailed findings with `/lazy-refactor report`

## Runs

Every scan creates a new **run** with its own findings and triage state (fixed/
ignored statuses). Previous runs are **not** purged. Use the `run_scan` MCP tool
(new run) or `resume_scan <id>` (re-scan an existing run, preserving your edits).
`list_runs` shows all runs — most recent first, with the active one marked and a
findings summary (archived runs hidden by default) — so you can recover the ID of a
prior session and resume it. `set_active_run <id>` switches to a prior run WITHOUT
re-scanning (cheap inspect/report); `delete_run <id>` permanently removes a run and
its findings. The active run persists across sessions, so `/report` and `/fix`
continue where you left off automatically. `set_run_status` marks a run
`in-progress`/`complete`/`archived`.

## Examples

```
/lazy-refactor scan
/lazy-refactor scan src/components
/lazy-refactor scan --focus=dead-code,duplicates
/lazy-refactor scan src --exclude=__tests__
```
