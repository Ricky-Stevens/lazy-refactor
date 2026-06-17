---
name: lz-list
description: List previous scan runs
---

# List Command

List previous scan runs so you can see what's been scanned and pick one to resume,
report on, or fix. Each `/lazy-refactor:lz-scan` creates a new **run** (its own findings
and triage state); runs are never purged, so they accumulate here.

## Usage

```
/lazy-refactor list [--all]
```

## Arguments

- `--all` (optional): Include archived runs. By default archived runs are hidden.

## Behavior

1. **Fetch runs**: Call `list_runs` (pass `includeArchived: true` when `--all` is given).
   Runs come back most-recent-first, with the active one flagged.

2. **Display a table**, one row per run:
   - **Run ID** — the id used by `/lazy-refactor:lz-resume <id>`
   - **Active** — mark the currently active run (e.g. `●`); this is the run `/lz-report`,
     `/lz-fix`, and `/lz-status` operate on
   - **Status** — `in-progress`, `complete`, or `archived`
   - **Scanned path**
   - **Last updated** — from `updatedAt`
   - **Findings** — total plus a severity breakdown (critical/high/medium/low) from the
     run's `summary`

3. **Handle no runs**: If `list_runs` returns an empty list, tell the user no scans exist
   yet and suggest `/lazy-refactor:lz-scan`.

4. **Suggest next actions**: Remind the user they can:
   - `/lazy-refactor:lz-resume <id>` — switch to a run and continue where they left off
   - `/lazy-refactor:lz-report` / `/lazy-refactor:lz-fix` — these act on the active run

## Examples

```
/lazy-refactor list
/lazy-refactor list --all
```
