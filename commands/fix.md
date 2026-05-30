---
name: fix
description: Apply fixes with test verification
---

# Fix Command

Apply fixes to code quality issues identified in scans, with test verification and dry-run mode.

## Usage

```
/lazy-refactor fix <id|all|critical|high> [--dry-run]
```

## Arguments

- `<target>` (required): What to fix. Options:
  - A specific finding ID (e.g., `f-abc12345def67890`) — fixes this finding regardless of its `fixable` flag (user override)
  - `all` — fix all open findings where `fixable: true`
  - `critical` — fix all fixable findings with severity `critical`
  - `high` — fix all fixable findings with severity `high` or above (`critical` + `high`)
- `--dry-run` (optional): Show what would be fixed without making changes.
- `--yes` (optional): Skip confirmation prompt and proceed automatically.

> **Note:** Non-fixable findings require manual intervention. Use `/report` to review them.

## Behavior

1. **Parse the target**:
   - If a finding ID, validate it exists and is open (bypass fixable check — user override)
   - If a severity level, fetch all open findings at that level **with `fixable: true`**
   - If `all`, fetch all open findings **with `fixable: true`**
   - When selecting more than a handful of findings, call `get_findings` with `compact: true` so the response stays small at scale. Use the `severity`/`category`/`file`/`check` filters to fetch exactly the set you need rather than paginating the whole store.

2. **Confirm with the user** before making any changes:
   - Display a table of findings that will be fixed, showing: id, description, severity, file (first location)
   - Print the total count, e.g. `3 finding(s) will be fixed.`
   - Also fetch non-fixable open findings and, if any exist, show a summary line: `N non-fixable finding(s) skipped (use /lazy-refactor report to review). These require manual intervention.` List their IDs, severities, and one-line descriptions so the user knows what's being left behind.
   - Ask the user to confirm: `Proceed? [y/N]`
   - If the `--yes` flag was passed, skip the prompt and proceed automatically
   - If the user does not confirm, abort with no changes made

3. **Dispatch the fixer agent in batches, not one-per-finding:**
   - **Group the selected findings by file** (first location's file). Treat each duplicate cluster as a single unit, as before.
   - Dispatch **one fixer agent per file-group**, passing it the list of finding IDs in that group. Independent groups (different files) can be dispatched in parallel.
   - This is the key throughput change: a 1,000-finding run becomes ~N file-group dispatches instead of 1,000 serial agent + tool-call round-trips.
   - Each fixer reads the finding details, understands context, makes the minimal targeted change per finding, runs tests, and reports per-finding outcomes.

4. **Dry-run mode** (when `--dry-run` is provided):
   - Analyze what would be fixed
   - Show a summary of changes that would be made
   - List affected files
   - Do not make actual changes
   - Do not run tests

5. **Handle results**:
   - Track which findings were successfully fixed
   - Track which fixes failed and report why
   - Persist statuses with **batched `update_findings` calls** (the `updates` mode with an array of `{id, status, notes?}`) — typically one call per file-group, or one call for the whole run. Never call `update_finding` once per finding. For bulk triage that doesn't need the fixer (e.g. mark an entire category `ignored`), use `update_findings` with `filter` + `status` in a single call.
   - Provide a summary report

6. **Report output**:
   - List each finding fixed or failed
   - Show test results for fixed findings
   - Indicate any rollbacks due to test failure
   - Provide a success/failure summary

## Examples

```
/lazy-refactor fix f-abc12345def67890
/lazy-refactor fix critical
/lazy-refactor fix all --dry-run
/lazy-refactor fix high
```
