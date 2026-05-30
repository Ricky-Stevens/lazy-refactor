---
name: report
description: Show findings from last scan
---

# Report Command

Display findings from the last scan, with optional filtering by severity and category.

## Usage

```
/lazy-refactor report [--severity=high] [--category=duplicates] [--status=open] [--language=go]
```

## Arguments

- `--severity` (optional): Filter findings by severity level. Options: `critical`, `high`, `medium`, `low`. If omitted, all severities are shown.
- `--category` (optional): Filter findings by category. Options: `duplicates`, `dead-code`, `metrics`, `patterns`, `modularity`, `comments`, `over-engineering`. If omitted, all categories are shown.
- `--status` (optional): Filter findings by status. Options: `open`, `fixed`, `ignored`, `in-progress`, `false-positive`, `stale`. Defaults to `open`.
- `--language` (optional): Filter findings by language. Options: `ts`, `js`, `go`, `python`, `csharp`, `java`. Matches the `language` field on pattern findings. If omitted, all languages are shown.

## Behavior

1. **Fetch findings**: Call `get_findings` with the specified filters (severity, category, status, language; `file` and `check` are also supported). This reports the **active run** — use `list_runs` to see all runs and `set_active_run <id>` to switch to a different one without re-scanning (or `resume_scan <id>` to re-scan into it). `delete_run <id>` removes a run you no longer need. For very large result sets, pass `compact: true` to get a lightweight projection (drops code snippets and bulky fields) and page with `limit`/`offset`.

2. **Format results**: Organize findings by:
   - Primary grouping: Severity level (Critical, High, Medium, Low)
   - Secondary grouping: Category within each severity
   - Include for each finding:
     - Finding ID
     - File and line number (if applicable)
     - Description
     - Severity and category
     - Confidence score (for AI-assessed findings)
     - Creation timestamp

3. **Display scores**: Show:
   - Total count of findings matching the filters
   - Breakdown by severity
   - Breakdown by category
   - Percentage of findings at each confidence level (if applicable)

4. **Provide context**: For each finding, include enough detail for the user to understand:
   - What the issue is
   - Why it matters
   - Where to find it in the code

5. **Handle no results**: If no findings match the filters, display a clear message indicating no findings were found matching the criteria.

## Examples

```
/lazy-refactor report
/lazy-refactor report --severity=high
/lazy-refactor report --category=dead-code --status=open
/lazy-refactor report --severity=critical,high --category=duplicates
/lazy-refactor report --language=go
/lazy-refactor report --language=csharp --severity=high
```
