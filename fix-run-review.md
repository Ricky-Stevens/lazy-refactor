# Lazy-Refactor Scan→Fix Run Review

**Source:** one real-world `/scan` → `/fix all` → follow-up-fix → `commit/push` session against an external Next.js app (`~/IPH/Next-Gen/AnalystUI`), run `r-mptqwprx-9b1e89`. 612 findings scanned, 467 dispatched to fixers, committed as `8f3558ea`.
**Goal:** use the run as evidence for concrete, implementable improvements to the **fix** side of the product (the prior `scan-quality-review.md` covered the scan/scoping side).
**Date:** 2026-05-31.
**Evidence base:** the session transcript. References to *this* repo's orchestration (`agents/fixer.md`, `commands/fix.md`, `commands/scan.md`) were read and verified; references to the target app are from the transcript.

---

## Executive summary

The **scan and assessment were excellent**; the **fix execution shipped silent dead code**. The single defining event: several fixer agents reported "split file X into a barrel + modules" as *done*, but only created the new sibling files — they never rewrote the original to re-export, and never wired any importer. ~22 orphan/duplicate files (including **duplicate Drizzle schema table definitions**) were committed **and pushed** before the user's "anything left over 300 lines?" caught it.

The reason it shipped is the important part: **every gate passed for the wrong reason.**

- `tsc` passed — orphan files are self-consistent and unimported, so they compile.
- `biome` passed — the code is clean, just unused.
- `4041/4041` unit tests passed — "split" test files were *copied*, not moved, so the originals stayed intact and the tests simply **ran twice**.
- The orchestrator's own completeness proof — *"test count unchanged → no tests lost or duplicated"* — was a false syllogism that actively masked the double-running.

The structural-fix contract in `agents/fixer.md` (lines 135–179) says *"preserve the public contract — re-export from the original path or update importers"* and *"do not fake completion."* The contract check **passed for the wrong reason**: leaving the original file fully intact trivially preserves every old import, so nothing broke and nothing was flagged. The half that was never enforced is *"the original must be reduced to a re-export."*

**The fix is in our own hands and it eats our own dog food:** an incomplete barrel-split is, by construction, exactly what our deterministic engine already detects — a new **unimported file** (dead-code) plus a **symbol now defined in two places** (duplication). The single highest-leverage change is a post-fix verification scan over the touched files. The rest are guards that turn "the agent *claims* it split the file" into "the agent *proved* it."

None of the recommendations reduce finding quantity. Two of them *raise* the priority of a real bug we under-ranked.

---

## What went well

1. **Scan + cross-category synthesis worked as designed.** The report correctly collapsed dozens of findings into three real clusters — the `insights/` agentic-loop hotspot (the architectural problem), the shadcn/Radix wrapper boilerplate, and seed/mock fixtures as low-priority noise. This is the `commands/scan.md` step-5 synthesis paying off; it's the signal a per-category dump would have buried.
2. **The two findings that actually mattered surfaced.** The `dangerouslySetInnerHTML` review and — more importantly — the **feature-flag production bug** (`step-data-model.tsx` reading `process.env.NEXT_PUBLIC_FF_*` directly instead of the hydrated `featureFlags`, silently hiding UI in deployed envs; see memory `global/nextjs/env-var-hydration`). Surfacing a real deployment bug from a "hygiene" scan is the product's high-water mark.
3. **The confidence floor behaved.** `minConfidence: 0.8` excluded the 81-finding low-confidence tail from the bulk pass exactly as `commands/fix.md` (lines 44–54) intends.
4. **Throughput scaled.** `group_findings(by:file)` → one fixer per file → parallel waves (21 fixers) is the architecture working; no single payload bloated context.
5. **The aggregate `tsc` pass earned its keep.** Per-agent tests are scoped to each agent's own files, so three **cross-batch** type regressions (an orphan importing a never-added type, a duplicate `getTaskAuditLog` re-export collision, a missing fixture field) were invisible per-agent and only the full `tsc` caught them. The orchestrator caught and repaired them before declaring done.
6. **Honest reporting.** The fix summary explicitly led with *"I had to repair the work before declaring done"* and listed the regressions. The follow-up task (feature flag + mock-setup) was clean end-to-end and captured the `vi.hoisted`-can't-be-shared gotcha to memory.

## What did not go well / what failed

1. **🔴 Silent incomplete structural splits → orphan duplicate files committed & pushed (the headline failure).** "Split into barrel" landed the *new* files but not the *original rewrite*. Type-valid and test-green, so every gate waved it through. Duplicate schema definitions in a pushed commit is the worst-case manifestation — two sources of truth for DB tables.
2. **False-confidence verification metrics.** *"4041 = 4041 tests"* was cited as proof of split correctness; it was the opposite — un-trimmed split test files double-run, so a stable count is consistent with *failure*. Green `tsc`/`biome` likewise cannot see unimported dead code. The gates we trust most are blind to this failure class.
3. **The structural-contract check passed for the wrong reason** (see executive summary) — the one place this *should* have been caught had a logic gap, not a missing step.

## What added friction

1. **Biome fighting the agent.** Auto-applied `biome check --write` repeatedly **reverted in-flight edits**: unused-import pruning rolled back the `QueueStats` consolidation (transient "unused" window), and the `import type {X}` + `export type {X} from` re-export pattern was rejected outright. The agent burned several cycles rediscovering this and eventually found the `export type X = Y` alias-re-export that survives pruning.
2. **Threshold thrash on marginal violations.** `review-page.tsx` (a 317-line file, 17 over) triggered a structural refactor that went `317 → 325 → 316 → 317`, net **zero**, ending with the `biome-ignore` re-added — after a long deliberation. A 1-line-over file (`use-validation-list-page.ts` at 301) got the same treatment. High effort, no value.
3. **`git stash` in a dirty, shared working tree.** The orchestrator stashed to check pre-existing failures; `stash pop` resurfaced *other people's* uncommitted work **and** reverted the agent's own in-flight extraction, then conflated "pre-existing" vs "introduced" test failures (hand-waved as "test isolation issues").
4. **Commit hygiene risk.** `git add -A` in that mixed tree staged 73 files; by the agent's own account the tree contained unrelated team work. Nothing confirmed the staged set matched the fix scope.
5. **Wall-clock.** 51 minutes for the bulk fix, a meaningful slice of it spent on items 1–2 above.

---

## Improvements & fixes (none reduce finding quantity)

Ranked by leverage. P0/P1 target the resilience failure that shipped; the rest reduce friction and sharpen signal.

### P0 — Post-fix verification scan (eat our own dog food) · resilience

After each fixer wave touches a set of files, re-run the **deterministic** `scan_dead_code` and `scan_duplicates` MCP tools **scoped to just those files** and diff against the pre-fix state. An incomplete barrel-split surfaces immediately as *new dead-code* (the unimported new module) + *new duplication* (the symbol now defined twice). This is the one change that would have caught the exact failure that shipped, it adds **zero tokens** (engine path), and it reuses tools we already expose with a path argument.

- **Where:** new step between `commands/fix.md` steps 5 and 6 ("Verify the fixes actually landed"), run by the orchestrator over the union of touched files per wave.
- **Action on a new finding in a touched file:** do **not** auto-mark `fixed`; flip the originating finding to `in-progress` with the regression noted, and surface it in the final summary as "fixes that introduced new findings."
- **Guardrail:** this is detection-only and deterministic — no engine/language branching, consistent with "no LLM in the scan path."

### P0 — Deterministic "did the split land" assertions in the fixer · resilience

Before a fixer may mark a **structural** finding (`modularity` / `complexity`-over-engineering, and any long-file split) as `fixed`, require three mechanical checks — fail any → status `in-progress` with a note, never `fixed`:

1. **The original file shrank.** A long-file/god-file finding whose source file did *not* decrease in line count was not split. (Cheap `wc -l` before/after.)
2. **Every newly-created file has ≥1 importer.** Grep the corpus for the new module path/symbol; zero importers = orphan.
3. **No symbol is defined in two places.** The original must *re-export* the moved symbol, not *redefine* it. (This is precisely the duplicate-schema bug.)

- **Where:** `agents/fixer.md`, appended to the **Structural Findings** process (currently lines 135–179) as a mandatory pre-`fixed` gate. Today step 3 says "preserve the public contract … re-export *or* update importers" but never verifies the original was reduced — close that half.

### P1 — Stop trusting green gates as a completeness proof · resilience

Document explicitly in both `agents/fixer.md` and `commands/fix.md`: **`tsc`/`biome`/test-count being unchanged does NOT prove a refactor landed** — orphan dead code is type-valid, and un-trimmed split test files run twice while staying green. For test-file splits specifically, assert (a) the original test file shrank, (b) the sum of `describe`/`it` blocks is *conserved*, not *duplicated*. Replace the "count unchanged → all good" heuristic with the P0 verification scan.

### P1 — Orchestrator commit hygiene & no `git stash` in a shared tree · resilience / friction

- **Baseline once, don't stash.** At the start of a `/fix` run, capture the failing-test baseline a single time (run the suite before any edits, record the failures). "Is this failure mine?" is then answered by comparison — no `git stash`/`pop`, which is unsafe in a tree holding other uncommitted work.
- **Stage the fix scope, not the world.** The commit step should stage only the files in the fix's touched-file set (derivable from the findings' locations + newly-created modules), or at minimum diff the working tree against that set and **surface "N changed files are outside the fix scope — confirm"** before `git add`. `git add -A` in a mixed tree is a correctness hazard.
- **Where:** `commands/fix.md` (the run owns git per `agents/fixer.md` line 75; fixers correctly never touch git). Note: this repo's git rule is ask-before-any-git and no co-author trailers (memories `global/git/no-co-authored-by`, `global/feedback/always-lint-and-test-before-push`) — the run honoured those.

### P1 — Biome-aware editing for consolidations · quality / friction

The formatter's unused-import pruning reverted a valid consolidation because there was a transient window where the new import looked unused. Add to `agents/fixer.md`:
- When consolidating a symbol (remove a local definition **and** add an import that replaces it), make **both** edits **before** running `biome check --write`, and confirm the symbol is referenced so the import survives pruning.
- Document the two patterns the run discovered the hard way: `import type {X}` + `export type {X} from "..."` of the same name in one file is **rejected** by Biome; the surviving re-export form is `export type X = Y` (alias). Worth a dedicated repo memory — it will recur on every barrel/consolidation fix in a Biome project.

### P2 — Don't thrash on marginal threshold violations · friction (quantity preserved)

A file a few lines over the long-file threshold with no clean seam should not trigger a structural refactor that makes it worse. **Do not suppress the finding** — instead let the fixer *defer fast*: for a long-file finding within a small band of the threshold (e.g. ≤5%) where no natural seam exists, mark `in-progress` with a one-line note after the *first* failed seam attempt, rather than thrashing through 8 edits. The finding still exists and still surfaces in `/report`; only the wasted fix-loop is removed.

- Optional engine-side complement (keeps quantity, lowers *bulk-fix* eagerness only): emit a **confidence** below the 0.8 bulk floor for files within the marginal band, so they still surface at `/report --minConfidence=0` but don't drive a bulk `/fix all` into a no-win refactor. This calibrates priority, it does not drop the finding.

### P2 — Give structural findings a fix-strategy hint at scan/assess time · quality / throughput

The assessor already writes a `suggestion`/`notes` for subjective categories. Extend that to carry a concrete seam plan for structural findings (e.g. "page component → extract a `useReviewPageState` hook"; "god-file → split by the N concerns at lines …"). The fixer then starts from the plan instead of rediscovering — and recognises the "page needs a hook extraction" dead-end *before* eight edits, not after. Pure throughput; counts unchanged.

### P3 — Raise precision-justified findings out of the low-confidence tail · findings (raises priority, removes none)

The **feature-flag production bug sat below the 0.8 floor**, so `/fix all` skipped it; it was only fixed because the user asked separately. A direct `process.env.NEXT_PUBLIC_*` read in client code is a *high-precision, deterministic* pattern (cf. memory `global/nextjs/env-var-hydration`), not a fuzzy heuristic — it deserves confidence high enough to enter the bulk pass and a severity that reflects a deployment-behaviour bug. Calibrate this specific consistency pattern **up**. This adds zero findings and removes none; it stops a real bug hiding in the tail.

---

## Architectural guardrails these changes respect

- **No LLM in the scan/verify path.** P0 verification reuses the existing deterministic `scan_dead_code`/`scan_duplicates`; the assertions are `wc -l`/grep. Fix-side intelligence stays in the agent layer, where AI is already permitted.
- **Engine stays language/framework-agnostic.** The marginal-band confidence tweak and the env-var precision bump live in *rule/config data*, not `if (framework === …)` branches.
- **Fixers never run git; the orchestrator does.** P1 commit hygiene lives in `commands/fix.md`, preserving the `agents/fixer.md` boundary.
- **Findings are never suppressed to look good** (memory `fix-philosophy`). Every recommendation either verifies a fix actually landed, reduces a wasted loop, or *raises* a finding's priority — none drop a finding or reach for `fixable:false`/`false-positive` on hard-but-valid work.

## Net recommendation

Ship **P0** (post-fix verification scan + the three deterministic split assertions) first — together they would have caught the orphan-file failure before it was committed, at zero token cost, by pointing our own detectors at our own output. Then **P1** (stop trusting green gates, commit/stash hygiene, Biome-aware consolidation), which removes the false confidence and the worst friction. P2/P3 sharpen throughput and signal. The through-line: the run proved the *detection* is trustworthy and the *fixing* needs the same standard of proof we already apply to scanning — verify, don't claim.
