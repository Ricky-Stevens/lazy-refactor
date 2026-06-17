---
name: lz-resume
description: Resume a previous scan run
---

# Resume Command

Resume a previous scan run — switch the active run back to it so `/lz-report`, `/lz-fix`, and
`/lz-status` operate on its findings again. **No re-scanning**: it reuses the findings already
collected, with your triage edits (fixed / ignored / false-positive / in-progress) intact.

This is the "scan once, fix over time" workflow: run a scan, then work through the findings.
If you get interrupted, sign off, or run out of tokens, you don't re-scan — you just resume the
run and keep fixing where you left off.

> **You often don't even need this.** The active run persists across sessions, so reopening a
> project and running `/lz-report` or `/lz-fix` already continues your last run. Use `resume` to switch
> *back* to an earlier run — find its ID with `/lazy-refactor:lz-list`.

## Usage

```
/lazy-refactor resume <id>
```

## Arguments

- `<id>` (required): The run ID to resume. Get it from `/lazy-refactor:lz-list`.

## Behavior

1. **Switch the active run**: Call `set_active_run` with the given `id`. This is instant — it
   only repoints the active run; it does not scan.
   - If the id doesn't exist, report the error and suggest `/lazy-refactor:lz-list` to find a valid
     id. Do not create or guess a run.

2. **Confirm and orient**: After switching, show the run's current summary (total findings,
   breakdown by severity and status) — the same shape as `/lazy-refactor:lz-status` — so the user can
   see what they're back in.

3. **Suggest next actions**: Point to `/lazy-refactor:lz-report` to review and `/lazy-refactor:lz-fix`
   to apply fixes against the now-active run.

> Need fresh findings because the code has changed? Run `/lazy-refactor:lz-scan` — that's a new scan,
> deliberately separate from resuming an existing one.

> **Don't confuse `/lz-resume` with the `resume_scan` MCP tool.** Despite the similar name, `resume_scan`
> is a *different* operation that re-activates a run **and re-runs detection into it** (a re-scan);
> this `/lz-resume` command deliberately uses `set_active_run` and does **not** re-scan.

## Examples

```
/lazy-refactor resume r-mps9pv01-56f4df
```
