---
name: lz-status
description: Show current scan and fix state
---

# Status Command

Display the current state of code quality scans and fixes.

## Usage

```
/lazy-refactor status
```

## Behavior

1. **Fetch summary**: Call `get_summary` to retrieve overall statistics about findings, and
   `get_active_run` to read the active run's identity (id, scanned path, scanId, status) in one
   cheap call — do NOT pull `list_runs` just to find the active run.

2. **Display state**:
   - **Total findings**: Count of all stored findings
   - **By status**: Breakdown of open, fixed, ignored, in-progress, false-positive, and stale findings
   - **By severity**: Count at each level (critical, high, medium, low)
   - **By category**: Count in each category, keyed by the stored `category` strings
     (e.g. `duplication`, `dead-code`, `metrics`, `modularity`, `comment-quality`,
     `complexity`, `consistency`, plus pattern-rule categories) — match `/lz-report`'s naming

3. **Show scan info** (from `get_active_run`):
   - Last scan ID
   - Scanned path
   - Note that this reflects the **active run**; `/lazy-refactor list` shows all runs and
     `/lazy-refactor resume <id>` switches to a different one

4. **Provide quick actions**:
   - Suggest running `/lazy-refactor scan` if no recent scans
   - Suggest running `/lazy-refactor fix critical` if critical findings exist
   - Suggest running `/lazy-refactor report --severity=high` to see high-severity findings
   - Suggest `/lazy-refactor list` to see previous runs

## Examples

```
/lazy-refactor status
```
