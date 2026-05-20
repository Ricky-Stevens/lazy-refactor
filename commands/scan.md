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
   - Count of findings by severity and category
   - Brief summary of top issues
   - Instructions for viewing detailed findings with `/lazy-refactor report`

## Examples

```
/lazy-refactor scan
/lazy-refactor scan src/components
/lazy-refactor scan --focus=dead-code,duplicates
/lazy-refactor scan src --exclude=__tests__
```
