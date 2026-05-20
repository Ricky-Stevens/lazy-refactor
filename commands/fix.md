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
  - A specific finding ID (e.g., `FIND-001`)
  - `all` — fix all open findings
  - `critical` — fix all critical findings
  - `high` — fix all high-severity findings
- `--dry-run` (optional): Show what would be fixed without making changes.

## Behavior

1. **Parse the target**:
   - If a finding ID, validate it exists and is open
   - If a severity level, fetch all findings at that level
   - If `all`, fetch all open findings

2. **Confirm with the user** before making any changes:
   - Display a table of findings that will be fixed, showing: id, description, severity, file (first location)
   - Print the total count, e.g. `3 finding(s) will be fixed.`
   - Ask the user to confirm: `Proceed? [y/N]`
   - If the `--yes` flag was passed, skip the prompt and proceed automatically
   - If the user does not confirm, abort with no changes made

3. **Dispatch the fixer agent** for each finding:
   - The fixer will read the finding details
   - Understand the codebase context
   - Make the minimal targeted change
   - Run tests to verify the fix

4. **Dry-run mode** (when `--dry-run` is provided):
   - Analyze what would be fixed
   - Show a summary of changes that would be made
   - List affected files
   - Do not make actual changes
   - Do not run tests

5. **Handle results**:
   - Track which findings were successfully fixed
   - Track which fixes failed and report why
   - Update finding statuses based on results
   - Provide a summary report

6. **Report output**:
   - List each finding fixed or failed
   - Show test results for fixed findings
   - Indicate any rollbacks due to test failure
   - Provide a success/failure summary

## Examples

```
/lazy-refactor fix FIND-001
/lazy-refactor fix critical
/lazy-refactor fix all --dry-run
/lazy-refactor fix high
```
