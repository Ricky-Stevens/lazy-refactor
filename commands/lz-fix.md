---
name: lz-fix
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

> **Note:** Non-fixable findings require manual intervention. Use `/lz-report` to review them.

## Execution Discipline — one gate, then finish the whole run

The user ran `/lz-fix` to get findings fixed. Get them fixed. Bias hard toward completion.

- **There is exactly ONE decision point: the confirmation in step 2.** Ask once, up front, then execute the entire selected set to completion. After the user confirms (or `--yes` is passed), do **not** ask again, re-confirm scope, "re-level", pause to reconsider, or stop to report partial progress and wait for a nudge. Drive every dispatched batch to the end and report once.
- **Don't re-litigate scope the user already chose.** If they said `all`, fix all of it. Don't shrink the job, propose a smaller subset, or stop midway to suggest deferring — that's the laziness this command exists to avoid.
- **False positives and risks are recorded, not escalated.** When fixers report findings that were wrong (build-critical deps, framework-wired exports, mis-detections), they're marked `false-positive` and the run continues. Collect these and surface them in the **final** summary — never halt the run to discuss them.
- **Keep dispatching until the work-list is empty.** Page through the findings, dispatch fixer batches in parallel waves, and only stop when every selected finding is fixed, reverted, or marked. A large count is the expected workload, not a reason to bail.

The only mid-run stop allowed is a genuine environment failure (e.g. the test command can't run at all). Discovering that some findings are noise is not a failure — it's a normal outcome to report at the end.

## Behavior

1. **Parse the target into a filter**:
   - If a finding ID, fetch it with `get_findings_by_ids` and validate it is open (bypass the
     fixable check — an explicit ID is a user override).
   - If a severity level, the filter is `{ status: "open", fixable: true, severity: <level(s)> }`
     (`high` ⇒ `["critical","high"]`) — **no confidence floor**. Explicitly targeting a severity
     tier is a deliberate scope choice, and `high`/`critical` is the last place you want a
     heuristic to hide a finding (see below).
   - If `all`, the filter is `{ status: "open", fixable: true, minConfidence: 0.8 }` — the floor
     applies to the **unscoped sweep only**.

   **The `all` sweep applies a confidence floor (`minConfidence: 0.8`).** Heuristic findings
   carry a confidence score, and the low-confidence tail (e.g. type-only dead-code exports,
   which the engine caps at 0.5 because `export * from` barrels hide them) is exactly where
   false positives concentrate — auto-fixing it across a whole run is how a bulk pass does
   damage. The floor gates *that sweep only*: a specific finding ID and an explicit severity
   target both **bypass** it (deliberate, narrowed scopes). If a user wants the low-confidence
   tail swept too, they can `/lz-report --minConfidence=0` to review it and fix by ID.

   **High/critical are unioned back into the `all` sweep regardless of confidence.** The floor
   exists to gate the *untriaged heuristic* tail — but `high`/`critical` is exactly the tier you
   do **not** want a confidence heuristic to hide. Suppressing it is how a real correctness bug
   slips a bulk pass — a silent feature-flag misconfiguration once sat below 0.8 and `/lz-fix all`
   skipped it. So for an `all` run, also pull `{ status: "open", fixable: true, severity:
   ["critical","high"] }` with **no `minConfidence`** and union it in. This *adds* findings to the
   set, never widens it toward the low-confidence *low/medium* tail. **Honest caveat:** there is
   no "assessor-confirmed" filter, so this also pulls in any *engine*-assigned high/critical that
   happens to be low-confidence — an accepted trade (high/critical is worth a fixer's attention,
   and the per-fixer self-verification + `false-positive` path is the safety net if one is noise).
   The reason this reliably catches *correctness* bugs like the flag misread is the assessor
   grading silent-misconfiguration / dropped-config as `high` — see its severity calibration.

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
   - **This is the only gate.** Once confirmed, go straight through steps 3–7 to completion without returning here.

3. **Dispatch the fixer agent in batches, not one-per-finding — and page the groups:**
   - **Capture a test baseline once, before the first dispatch.** Run the project's typecheck
     and full suite a single time and record any **pre-existing** failures. This is what lets
     the final verification pass (step 5) tell an introduced regression from a failure that was
     already there — without resorting to `git stash`. One run, up front; do not re-baseline
     per wave.
   - **Group server-side with `group_findings`** — call it with `by: "file"` and the same
     filter from step 1. It returns `{ groups: [{ key: file, count, ids }], totalGroups,
     totalFindings, offset, limit, returnedGroups, truncated }` — the file→finding-ID map you
     need, **without** any finding bodies. Never fetch all findings and group them yourself,
     and **never read raw tool-result files off disk** to build the grouping.
   - **One file = one group = one fixer.** Each group's `key` is a single root-relative path
     and every finding for that file is in it (duplicate clusters group under their primary
     file). Never dispatch two fixers against the same file — concurrent edits corrupt it.
   - **Page through the groups; do NOT pull all of them at once.** `group_findings` returns at
     most `limit` groups (default 200, count-desc). Process the returned wave fully — dispatch
     **one fixer agent per group in parallel** (passing only that group's `ids`; the fixer calls
     `get_findings_by_ids` for its own details), collect outcomes — and only THEN, **if
     `truncated` is true**, call `group_findings` again with `offset += limit` for the next
     wave. A 235-group run is several bounded waves, not one giant payload that bloats context.
   - This is the key throughput change: a 1,000-finding run becomes ~N file-group dispatches
     across a few waves instead of 1,000 serial agent + tool-call round-trips.
   - Each fixer reads its findings' details, understands context, makes the minimal targeted
     change per finding, runs tests, and reports per-finding outcomes.

4. **Dry-run mode** (when `--dry-run` is provided):
   - Analyze what would be fixed
   - Show a summary of changes that would be made
   - List affected files
   - Do not make actual changes
   - Do not run tests

5. **Verify the fixes actually landed — green gates are not proof.** A clean `tsc`, a clean
   `biome`, and an unchanged test count are all consistent with a **half-applied refactor**:
   an orphan "extracted" module that nothing imports still compiles, the linter sees it as
   clean-but-unused, and a "split" test file left intact just runs **twice** and stays green.
   Per-agent test runs are scoped to one agent's files, so they cannot see cross-batch breakage
   either. Two verification passes close this:
   - **The fixer's own three checks (original shrank / new files imported / no double
     definition) are the primary guard** — they're tool-independent (`wc`/grep) and catch the
     test-file double-create case too. The orchestrator re-scan below is the backstop.
   - **Scoped re-scan after any refactor wave (deterministic, zero-token — eat our own dog
     food).** If a wave included structural/refactor findings (`modularity`, `complexity`/
     over-engineering, `duplication` extractions, or `metrics-long-file` splits), re-run
     `scan_dead_code` and `scan_duplicates`. These tools take a **single directory `path`** (not
     a file list) and **return results inline without persisting** — so there's no run-corruption
     or stale-marking risk, but you must scope and filter yourself: scan the directory containing
     the wave's touched/created files (their common parent if they span dirs) and **filter the
     returned list to just those files**. Pass `excludeTests: false` to `scan_duplicates` so a
     duplicated *test* file is caught too (it defaults to excluding tests). Read the `deadCode`
     array from `scan_dead_code`'s envelope. A half-landed split is, by construction, exactly what
     these detect: a **new unimported file** (dead-code) and a **symbol now defined in two places**
     (duplication). Two cases, and the first needs no diff:
     - **Newly-created files** didn't exist at scan time, so **any** dead-code or duplication the
       re-scan reports *on them* is new by definition — an orphan the fixer just added. No
       comparison needed; its presence is the signal.
     - **Pre-existing touched files**: compare the re-scan against the run's prior findings for
       those files (`get_findings` with a `file` filter); only a finding *not* already on record
       counts as introduced.
     Either way, an introduced finding means the refactor didn't land: **flip the originating
     finding from `fixed` to `in-progress`**, note it, and surface it in the summary under "fixes
     that introduced new findings." A wave that was purely surgical (no structural findings at
     all) can skip the re-scan; in practice most file-groups mix the two, so expect it to run —
     it's cheap (engine path), not a per-finding cost.
   - **One full typecheck + suite at the very end.** After all waves, run the project's
     typecheck and full test suite **once** to catch cross-batch regressions the per-agent runs
     could not. Diff failures against the **pre-fix baseline** you captured before dispatching
     (step 3) so introduced failures are distinguishable from pre-existing ones — do **not**
     `git stash` to find that out (stashing in a working tree that may hold unrelated changes
     resurfaces other people's work and can revert in-flight edits). Repair any introduced
     regression before declaring done.

6. **Handle results**:
   - Track which findings were successfully fixed, which failed (and why), and which the
     verification pass demoted to `in-progress`
   - Persist statuses with **batched `update_findings` calls** (the `updates` mode with an array of `{id, status, notes?}`) — typically one call per file-group, or one call for the whole run. Never call `update_finding` once per finding. For bulk triage that doesn't need the fixer (e.g. mark an entire category `ignored`), use `update_findings` with `filter` + `status` in a single call.

7. **Report output**:
   - List each finding fixed or failed, and any demoted to `in-progress` by verification
   - Show the final typecheck/test result and any rollbacks due to test failure
   - Provide a success/failure summary

## Committing & working-tree hygiene

`/lz-fix` does not commit — the user decides when. When they do ask you to commit the run:
- **Stage the fix's scope, not the world.** The touched-file set is derivable from the fixed
  findings' locations plus any modules the fixers created. Stage that set; do not `git add -A`
  in a tree that may hold unrelated in-flight work. If the working tree contains changes
  outside the fix scope, **surface them and confirm** before staging — never sweep them into
  the refactor commit.
- **Never `git stash` to triage failures** (see step 5) — use the captured baseline instead.

## Examples

```
/lazy-refactor fix f-abc12345def67890
/lazy-refactor fix critical
/lazy-refactor fix all --dry-run
/lazy-refactor fix high
```
