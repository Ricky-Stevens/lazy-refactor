---
name: lz-report
description: Show findings from last scan
---

# Report Command

Display findings from the last scan, with optional filtering by severity and category.

## Usage

```
/lazy-refactor report [--severity=high] [--category=duplication] [--status=open] [--language=go]
```

## Arguments

- `--severity` (optional): Filter findings by severity level. Options: `critical`, `high`, `medium`, `low`. If omitted, all severities are shown.
- `--category` (optional): Filter findings by category. Values match the stored `category` field exactly (no aliasing). Options: `duplication`, `dead-code`, `metrics`, `modularity`, `complexity`, `consistency`, `security`, `comment-quality`, `error-handling`, `type-safety`, `deprecated-patterns`, `correctness`, `maintainability`, `resource-leaks`, `resource-management`, `react-hooks`, `debugging-leftovers`, `hardcoded-values`, `hardcoded-magic-values`, `concurrency`. If omitted, all categories are shown.
- `--status` (optional): Filter findings by status. Options: `open`, `fixed`, `ignored`, `in-progress`, `false-positive`, `stale`. Defaults to `open`.
- `--language` (optional): Filter findings by language. Values match the stored `language` field exactly (no aliasing). Options: `typescript`, `go`, `python`, `csharp`, `java`, `common`. Matches the `language` field on findings. If omitted, all languages are shown.

## Behavior

1. **Fetch findings**: Call `get_findings` with the specified filters (severity, category, status, language, `fixable`, `minConfidence`; `file` and `check` are also supported). Pass `orderBy: "severity"` so the page comes back already most-severe-first — you do NOT need to pull every finding and sort client-side for the by-severity report. This reports the **active run** (call `get_active_run` for its id/path header); use `list_runs` to see all runs and `set_active_run <id>` to switch to a different one without re-scanning (or `resume_scan <id>` to re-scan into it). `delete_run <id>` removes a run you no longer need. For very large result sets, pass `compact: true` to get a lightweight projection (drops code snippets and bulky fields) and page with `limit`/`offset`.

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
   - **Keep the severity headline scope-honest.** Vendored/minified/generated files are
     excluded by default, but if a user has re-included such a path (via config) and it is
     inflating the critical/high counts, note that separately so the headline reflects
     first-party code rather than a checked-in bundle. A single vendored blob can otherwise
     manufacture a false "critical".

4. **Provide context**: For each finding, include enough detail for the user to understand:
   - What the issue is
   - Why it matters
   - Where to find it in the code

5. **Handle no results**: If no findings match the filters, display a clear message indicating no findings were found matching the criteria.

6. **Flagging files to never scan again**: If a finding is on a file the user never wants scanned (a seed script, a test/fixture script, a generated helper), call `update_ignore_list` with `{ "add": ["<project-relative path>"] }` to add it to the curated ignore list. A plain path silences a single file or an entire directory's contents; future scans skip it. This is distinct from marking a finding `ignored` (which silences one finding) and from `.gitignore`/`exclude`. Use `get_ignore_list` to show what's currently ignored and `update_ignore_list` with `remove` to un-flag.

## Examples

```
/lazy-refactor report
/lazy-refactor report --severity=high
/lazy-refactor report --category=dead-code --status=open
/lazy-refactor report --severity=critical,high --category=duplication
/lazy-refactor report --language=go
/lazy-refactor report --language=csharp --severity=high
```
