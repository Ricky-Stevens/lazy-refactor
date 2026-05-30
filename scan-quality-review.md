# Lazy-Refactor Scan-Quality Review

**Source:** one real-world scan of an external Next.js app (~6k files, 1,014 findings, run `r-mpsqp0pv-7c282c`).
**Goal:** use that run as evidence to find concrete, implementable improvements to the lazy-refactor product.
**Date:** 2026-05-30.

All file:line references below are to this repo and were verified against source, not inferred.

---

## Executive summary

The engine is structurally sound and swept the tree completely, but the run was **~65–70% noise**, and the noise is concentrated in a small number of *fixable* sources — not spread evenly. Three takeaways:

1. **The scary headline numbers are an artifact of bad scoping defaults.** The single "critical" (`eval`) and roughly half of the 60 "high" findings (`empty-catch`) come entirely from one vendored directory — `public/tesseract/*.min.js` / `*.wasm.js` (minified OCR runtime). That directory is *not excluded by default* and the offending rules *lack vendor/minified guards*. Strip it and "1 critical / 60 high" collapses to roughly "0 critical / ~27 high".

2. **One category is architecturally broken for any config-driven toolchain.** `unused-dep` was **60/60 wrong**. It only greps source files, never config files or `package.json` scripts, so it cannot see `typescript`, `tailwindcss`, `@biomejs/biome`, `@playwright/test`, `@types/*`, `@radix-ui/*`, etc. This isn't tuning — the detection model is incomplete.

3. **The fixes are cheap and respect the architecture.** Most of the noise dies by editing two kinds of *data*: `DEFAULT_CONFIG.exclude` and the per-rule `exclude:[]` glob arrays. No engine branching, no LLM in the scan path, no violation of "rules are data, not logic."

The genuine signal in the run was **`duplication`** (confidence 1.0) plus a cross-category architectural finding (route-layer boilerplate + a half-finished `withPermission` migration) that *no single check surfaced* — it only emerged by reading duplication + consistency + modularity together.

---

## Findings, grounded in code

| # | Symptom in the run | Root cause (file:line) | Class |
|---|---|---|---|
| 1 | 1 critical (`eval`) + ~31 high (`empty-catch`) from `public/tesseract/*.min.js`/`*.wasm.js` | `public/` not in `SKIP_DIRS` (`src/engine/files.js:24`); `DEFAULT_CONFIG.exclude` omits `public/**`, `**/*.min.js`, `**/*.wasm.js` (`src/mcp/helpers.js:23`); `empty-catch-ts`/`eval-usage-ts` `exclude` arrays lack `vendor`/minified/`dist`/`build` (`src/rules/typescript.js:25`, `:248`) | **Scoping defaults** |
| 2 | 60/60 `unused-dep` false positives | `scanUnusedDeps` only feeds `collectFiles()` source into the match corpus — never `*.config.*`, `biome.json`, `tsconfig.json`, or `package.json` scripts (`src/engine/cross-ref/scan-unused-deps.js:128-140`) | **Incomplete detection** |
| 3 | ~80% of 199 dead-code exports false (`PageHeaderProps`, type exports, `config`/`nextConfig`) | Type-only exports recorded as value exports (no type/value distinction in `extract-exports.js`); TS confidence fixed at **0.9** (`scan-dead-code.js:151`); `export * from` barrels are a *known accepted* FP source (see CLAUDE.md) | **Confidence / known gap** |
| 4 | ~50% of 106 `metrics-long-file` false (table-driven `*.test.ts`) | Single 300-line threshold applied to every file; no test-file exclusion or raised threshold (`src/engine/metrics.js:22-34`, threshold `src/mcp/helpers.js:15`) | **Threshold tuning** |
| 5 | 110/120 `comment-quality` dismissed (barrels, JSDoc/license headers, test dividers) | `ai-step-comment` pattern too broad + only excludes `node_modules`/`vendor` (`src/rules/common.js:47,50`); `metrics-excessive-comments` has **no guards** and a flat 0.5 ratio (`src/engine/metrics.js:112-126`) | **Rule tuning** |
| 6 | `hardcoded-url` mostly noise (`next-env.d.ts`, `seed.ts`) | Good `exclude` list but missing `**/*.d.ts` / `**/next-env.d.ts` / seed paths (`src/rules/common.js:66-81`) | **Guard gap** |
| 7 | Three scattered findings were really *one* architectural issue | No cross-category synthesis step; report is per-category, so convergent signals fragment | **Pipeline** |
| 8 | Most expensive triage pass (comment-quality, 77k tokens / 42 tool calls) spent almost entirely *confirming noise* | Triage runs *before* scope/guard tuning, so assessors pay Opus-grade reasoning to dismiss barrels and test dividers | **Pipeline ordering / cost** |

### What the scan structurally *cannot* find (scope honesty)
It is a syntactic/heuristic scanner. It flagged `eval` in a vendored blob but would **not** flag a missing `checkPermission` on a real route — the auth/data-flow class that matters most here. Worth stating plainly in product docs so users calibrate trust; it is not a defect to "fix," but it bounds the value proposition.

---

## Ranked improvements

### P0 — Scoping defaults (biggest single win, ~1 hr, kills the false critical + ~half the highs)
Edit `DEFAULT_CONFIG.exclude` in `src/mcp/helpers.js:23`:
```js
exclude: [
  "vendor/**", "generated/**", "*.generated.*", "node_modules/**", ".git/**",
  // additions:
  "**/*.min.js", "**/*.min.css", "**/*.wasm.js",   // minified / wasm blobs
  "**/*.d.ts",                                       // type-decl files (incl. next-env.d.ts)
  "public/**",                                       // framework static/vendored assets
  "**/*.test.*", "**/*.spec.*", "**/__tests__/**",   // tests (see P2 for the nuanced alternative)
],
```
And tighten the two security rules that produced the scariest output — add `**/*.min.js`, `**/vendor/**`, `**/dist/**`, `**/build/**` to the `exclude` arrays of `empty-catch-ts` (`src/rules/typescript.js:25`) and `eval-usage-ts` (`:248`). Defence in depth: even if a user re-includes `public/`, a minified blob still shouldn't raise a critical.

> Caveat to weigh: blanket-excluding `**/*.test.*` removes tests from *every* check, not just metrics. If we want lint-style smells (empty catch, `eval`) still caught in tests, prefer the per-rule/threshold approach in P2 over a global test exclusion. Recommend: global-exclude `*.min.js`/`*.wasm.js`/`*.d.ts`/`public/**` (never want those), but handle tests via threshold, not exclusion.

### P1 — Fix `unused-dep` or disable it by default
It is net-negative as shipped. Two options:
- **Fix (preferred):** before the match loop in `scanUnusedDeps` (`src/engine/cross-ref/scan-unused-deps.js:128`), also read non-source config into the corpus — `*.config.{js,ts,mjs,cjs}`, `biome.json`, `tsconfig*.json`, `.eslintrc*`, and `package.json` `scripts`. For `@types/*`, also count a hit on the base package (`@types/node` → `node`). This is additive and language-agnostic (config discovery, not framework branching).
- **Stopgap:** add `unused-dep` to `DEFAULT_CONFIG.disabledChecks` until fixed, or drop its confidence so it never surfaces above `medium`. Shipping a check that is ~100% wrong on the dominant ecosystem erodes trust in the whole tool.

### P1 — Comment-quality rules (220 of the dismissals)
- `metrics-excessive-comments` (`src/engine/metrics.js:112-126`): add a guard so barrels/`index`/header-heavy files don't trip it (e.g. ignore when code-line count is tiny — a 5-line barrel with a license header is not "over-commented"), and reconsider the flat `0.5` ratio. This is the single noisiest check and has *zero* guards today.
- `ai-step-comment` (`src/rules/common.js:41`): the pattern `\d+\.\s+\w` matches ordinary numbered JSDoc/prose. Tighten to require the literal `step` keyword, or raise specificity; at minimum add `**/*.test.*`, `**/*.d.ts` to its `exclude`.

### P2 — Metrics test-file handling
In `src/engine/metrics.js:22-34`, branch the `metrics-long-file` threshold on `isTestFile(file)` (helper already exists and is used by dead-code at `scan-dead-code.js:149`) — e.g. allow tests ~2× `maxFileLines`. Same idea for `metrics-excessive-comments`. This keeps the engine language-agnostic (test detection is filename-based, not framework-specific) and avoids excluding tests from real smell checks.

### P2 — Dead-code confidence calibration
Don't add Next.js routing branches to the engine — that would violate "engine code should not know about specific languages/frameworks." Instead:
- Mark type-only exports (`export type`/`export interface`) at lower confidence than value exports, since `export * from` barrels (a documented, accepted FP source) disproportionately hide them.
- Surface confidence in the report and default `/fix` to a confidence floor (e.g. ≥0.8) so the 0.9-confidence TS exports still show but the long tail doesn't drive bulk fixes.

### P3 — `hardcoded-url` guard gap
Add `**/*.d.ts`, `**/next-env.d.ts`, and common seed paths (`**/seed*.{ts,js}`, `**/seeds/**`, `**/fixtures/**`) to the `exclude` at `src/rules/common.js:66`.

---

## Pipeline / orchestration improvements (agents & commands, not engine)

1. **Reorder the scan pipeline: scope-fix → scan → triage.** The run triaged *before* excluding vendored/generated files, which is why the comment-quality assessor burned 77k tokens dismissing barrels and test dividers. Land the P0/P1 default-scope changes and that triage cost largely disappears. If a project still has unusual noise, suggest config exclusions and re-scan *before* dispatching assessors.
2. **Add a cross-category synthesis step.** The one real architectural finding (route-layer boilerplate + half-finished `withPermission` migration) existed as three disconnected findings across duplication/consistency/modularity. A post-triage pass that clusters confirmed findings by code area would surface convergent signals as a single high-value item instead of three scattered ones. This is the highest-leverage *new* capability the run revealed.
3. **Make the severity table scope-aware in reporting.** "1 critical / 60 high" was actively misleading because it counted vendored files. Even before the scoping fix lands, the report header should separate (or flag) findings from likely-vendored/generated paths so the headline reflects first-party code.

---

## Architectural guardrails these changes must respect

- **Engine stays language/framework-agnostic.** Framework awareness (Next.js conventions, config-driven deps) belongs in *rule data* (`exclude` globs), *config defaults*, or filename-based helpers — never `if (framework === …)` branches in the engine. (CLAUDE.md: "rule files are data, not logic.")
- **No LLM in the scan path.** All P0–P3 fixes are deterministic data/threshold edits. Triage/synthesis improvements live in the agent layer, where AI is already permitted.
- **`export * from` and dynamic `import()` dead-code FPs are a known, accepted trade-off** — the dead-code P2 item *calibrates around* it (confidence), it does not try to "solve" it.
- **300-line source-file limit** still applies to any engine/rule files we touch.

---

## Net recommendation

Ship P0 (scope defaults + security-rule guards) and the `unused-dep` decision first — together they remove the false critical, ~half the highs, and the worst whole-category miss for roughly an afternoon of work, and they make every future triage pass cheaper. Then P1 comment-quality tuning. Treat duplication as the trustworthy category and invest in the cross-category synthesis step as the one genuinely new capability worth building.
