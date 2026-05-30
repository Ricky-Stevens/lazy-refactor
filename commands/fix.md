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

## Execution Discipline — one gate, then finish the whole run

The user ran `/fix` to get findings fixed. Get them fixed. Bias hard toward completion.

- **There is exactly ONE decision point: the confirmation in step 2.** Ask once, up front, then execute the entire selected set to completion. After the user confirms (or `--yes` is passed), do **not** ask again, re-confirm scope, "re-level", pause to reconsider, or stop to report partial progress and wait for a nudge. Drive every dispatched batch to the end and report once.
- **Don't re-litigate scope the user already chose.** If they said `all`, fix all of it. Don't shrink the job, propose a smaller subset, or stop midway to suggest deferring — that's the laziness this command exists to avoid.
- **False positives and risks are recorded, not escalated.** When fixers report findings that were wrong (build-critical deps, framework-wired exports, mis-detections), they're marked `false-positive` and the run continues. Collect these and surface them in the **final** summary — never halt the run to discuss them.
- **Keep dispatching until the work-list is empty.** Page through the findings, dispatch fixer batches in parallel waves, and only stop when every selected finding is fixed, reverted, or marked. A large count is the expected workload, not a reason to bail.

The only mid-run stop allowed is a genuine environment failure (e.g. the test command can't run at all). Discovering that some findings are noise is not a failure — it's a normal outcome to report at the end.

## Behavior

1. **Parse the target into a filter**:
   - If a finding ID, fetch it with `get_findings_by_ids` and validate it is open (bypass the
     fixable check — an explicit ID is a user override).
   - If a severity level, the filter is `{ status: "open", fixable: true, severity: <level(s)>, minConfidence: 0.8 }`
     (`high` ⇒ `["critical","high"]`).
   - If `all`, the filter is `{ status: "open", fixable: true, minConfidence: 0.8 }`.

   **Bulk targets apply a confidence floor (`minConfidence: 0.8`).** Heuristic findings
   carry a confidence score, and the low-confidence tail (e.g. type-only dead-code exports,
   which the engine caps at 0.5 because `export * from` barrels hide them) is exactly where
   false positives concentrate — auto-fixing it across a whole run is how a bulk pass does
   damage. A specific finding ID is a user override and **bypasses** this floor (fix it
   regardless of confidence). If a user wants the low-confidence tail swept too, they can
   `/report --minConfidence=0` to review it and fix by ID.

   **Never bulk-load the store.** `fixable` is a first-class filter — combine it with
   `status`/`severity`/`category`/`file`/`check` so the query returns exactly the set you intend
   to fix. Then:
   - **Size first:** call `count_findings` with the filter to learn the total. Do NOT fetch
     everything just to count it.
   - **Page through it:** call `get_findings` with the filter, `compact: true`, and explicit
     `limit`/`offset` (e.g. `limit: 200`), advancing `offset` by `limit` until you have read the
     full count. The response carries `total` and a `truncated` flag — keep paging while
     `truncated` is true. Process each page (group by file, dispatch fixers) before fetching the
     next, so no single payload is ever large.
   - If a page is still unwieldy, narrow the filter further (per `category`/`severity`) rather
     than widening the page. Reading raw tool-result files off disk is never necessary.

2. **Confirm with the user** before making any changes:
   - Display a table of findings that will be fixed, showing: id, description, severity, file (first location)
   - Print the total count, e.g. `3 finding(s) will be fixed.`
   - Also fetch non-fixable open findings and, if any exist, show a summary line: `N non-fixable finding(s) skipped (use /lazy-refactor report to review). These require manual intervention.` List their IDs, severities, and one-line descriptions so the user knows what's being left behind.
   - Ask the user to confirm: `Proceed? [y/N]`. Keep it to this single line — present the count and the table, not a persuasive case for doing less. Do not editorialise about the work being large, risky, or better deferred; if you have a genuine must-flag risk, state it in one sentence and still ask the plain `Proceed?`.
   - If the `--yes` flag was passed, skip the prompt and proceed automatically
   - If the user does not confirm, abort with no changes made
   - **This is the only gate.** Once confirmed, go straight through steps 3–6 to completion without returning here.

3. **Dispatch the fixer agent in batches, not one-per-finding:**
   - **Group server-side with `group_findings`** — call it with `by: "file"` and the same
     filter from step 1. It returns `{ groups: [{ key: file, count, ids }], totalGroups,
     totalFindings }` — the file→finding-ID map you need, **without** any finding bodies.
     Never fetch all findings and group them yourself, and **never read raw tool-result files
     off disk** to build the grouping; `group_findings` is the supported path and its response
     stays small even for thousands of findings. (Duplicate clusters group under their primary
     file, so they remain a single unit.)
   - Dispatch **one fixer agent per group**, passing it that group's `ids`. The fixer calls
     `get_findings_by_ids` to load just its own findings' details. Independent groups (different
     files) can be dispatched in parallel.
   - This is the key throughput change: a 1,000-finding run becomes ~N file-group dispatches
     instead of 1,000 serial agent + tool-call round-trips.
   - Each fixer reads its findings' details, understands context, makes the minimal targeted
     change per finding, runs tests, and reports per-finding outcomes.

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
