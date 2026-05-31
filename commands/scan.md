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
- `--exclude` (optional): Glob pattern(s) to exclude from the scan. Matched against both the file's relative path and its name. Supports `*`, `**`, `?`, and `{a,b}` brace alternation (NOT regex). E.g. `--exclude=node_modules` or `--exclude=**/*.test.ts`.

## Behavior

> **Just run it.** A bare `/scan` has everything it needs — don't ask which path or categories; default to the working directory and all categories. Drive the whole flow (scan → assess → report) to completion and report once. Don't stop to ask questions or check in mid-scan.

> **Scope before you triage.** The engine already excludes vendored/minified/generated
> artifacts and `public/**` by default (assessing those wastes triage budget on noise the
> scan shouldn't have raised). If a scan still shows findings heavily concentrated in one
> obviously-derived path (a checked-in bundle, a generated client, a fixtures tree), add an
> `--exclude` for it and re-scan **before** fanning out assessors, rather than paying to
> dismiss the noise. Order is scope → scan → triage.

This command orchestrates two kinds of worker agent — the same command-orchestrates,
workers-are-leaves pattern `/fix` uses. The **scanner** runs the fast deterministic
scan; the **assessor** deep-triages the four subjective categories in parallel. The
workers never dispatch each other — *this command* fans them out.

1. **Parse arguments**: Extract path, focus categories, and exclusion patterns.

2. **Dispatch the scanner agent** with the target path, focus areas (or all), and
   exclusion patterns. The scanner detects languages, runs the engine scans, persists
   findings, and returns a structured summary — **including the per-category counts for
   the four subjective categories**, which are the exact stored `category` strings
   `modularity`, `comment-quality`, `complexity` (over-engineering), and `consistency`
   (inconsistent patterns). The scanner does NOT triage these; it makes no `Read` calls.

3. **Fan out assessor agents in parallel** over the subjective findings. The subjective
   set is exactly those four `category` values: `modularity`, `comment-quality`,
   `complexity`, `consistency`.
   - If the scanner reports zero findings across all four, **skip this step** — there is
     nothing to assess.
   - Otherwise, for each of those four categories that is non-empty, get its finding IDs
     with `group_findings` (`by: "category"` — match on the literal strings above; or
     `by: "file"` then filter to a subjective category to split a large category into
     file-group batches). Never bulk-load finding bodies here.
   - Dispatch **one assessor agent per category** (or per file-group for large
     categories), passing it that batch's IDs. Independent batches run in parallel —
     this is the parallelism that makes the scan both faster and more thorough than a
     single serial triage pass. Each assessor loads its own findings, assesses them, and
     writes its verdicts in one batched `update_findings` call.

4. **Handle errors**:
   - If the path does not exist, report an error
   - If no valid files are found in the path, report that no scannable files were found
   - If the scanner or an assessor encounters an error, display the error details and advise the user. One assessor failing does not abort the others or the report.

5. **Synthesize across categories** — before formatting the report, look for one
   *code area* (file, directory, or layer) that shows up in **multiple** categories at
   once: e.g. duplication + consistency + modularity all firing on the same route/query
   layer is one architectural problem (un-DRYed boilerplate, a half-finished migration),
   not three unrelated findings. Use `group_findings` (`by: "file"`) to spot files that
   recur across categories. Surface each convergent cluster as a single high-value item
   in the report — a per-category list buries the signal that matters most.

6. **Report output** — build this AFTER assessors finish, from `get_summary` /
   `count_findings` / paged `get_findings` (small, SQL-side counts; never materialise the
   whole set). Display:
   - The new run ID (each scan creates a new run)
   - If the scan result includes `ignoredFiles` (> 0), state plainly that **N files were skipped by the project's ignore list** and were not scanned by ANY check — so the suppression is visible and the user can reconcile it (use `get_ignore_list` to show what's ignored). An ignored path exempts code from security checks too, so this is never hidden in the headline.
   - If the scan result includes `carriedDismissals`, say plainly that **N findings you previously marked false-positive/ignored were carried forward** from the prior run (by stable finding id) and are already dismissed in this run — so prior triage is honoured automatically. **Trust this persisted state over any recollection or memory of "this repo is all noise":** finding statuses in the DB are the source of truth, assessed fresh per run. Do NOT pre-dismiss whole checks (e.g. "long-file is always noise here") from memory — long-file and dead-code are real signal and must be assessed against the actual current findings each run.
   - Count of findings by severity and category (post-assessment — dismissed findings now sit at `false-positive`)
   - The cross-category clusters from step 5, called out first
   - Brief summary of top issues
   - Instructions for viewing detailed findings with `/lazy-refactor report`

## Runs

Every scan creates a new **run** with its own findings and triage state (fixed/
ignored statuses). Previous runs are **not** purged. Use the `run_scan` MCP tool
(new run) or `resume_scan <id>` (re-scan an existing run, preserving your edits).
`list_runs` shows all runs — most recent first, with the active one marked and a
findings summary (archived runs hidden by default) — so you can recover the ID of a
prior session and resume it. `set_active_run <id>` switches to a prior run WITHOUT
re-scanning (cheap inspect/report); `delete_run <id>` permanently removes a run and
its findings. The active run persists across sessions, so `/report` and `/fix`
continue where you left off automatically. `set_run_status` marks a run
`in-progress`/`complete`/`archived`.

## Examples

```
/lazy-refactor scan
/lazy-refactor scan src/components
/lazy-refactor scan --focus=dead-code,duplicates
/lazy-refactor scan src --exclude=__tests__
```
