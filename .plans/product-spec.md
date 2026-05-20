# lazy-refactor — Product Specification

## What This Is

A Claude Code plugin that scans codebases for code quality and maintainability issues, prioritises findings, and automatically fixes them with test verification. It targets the mess that AI coding agents create: duplication, dead code, inconsistent patterns, unnecessary complexity, and all the other things that make a codebase unmaintainable.

## The Problem

AI coding tools generate code fast but don't consolidate, don't refactor, and don't maintain consistency. The data is clear:

- Refactored code dropped from 25% of all changes in 2021 to under 10% in 2024 (GitClear, 211M lines analysed)
- Code duplication increased 4-8x in AI-heavy codebases
- Copy-pasted code now exceeds refactored code for the first time
- Code churn (lines reverted within 2 weeks) doubled from 3.3% to 7.1%
- Maintenance costs for unmanaged AI-generated code reach 4x traditional levels by year two
- AI-generated PRs contain 1.7x more issues overall (CodeRabbit, 470 PRs analysed)

The result: codebases that work but are increasingly unmaintainable. Nobody cleans up after the AI.

## The Gap

The full pipeline of **detect → prioritise → fix → verify** does not exist as a single product. The landscape:

- **Detection tools exist**: Drift (architectural erosion), jscpd (duplicates), knip (dead code JS/TS), SonarQube (quality metrics). These find problems but don't fix them.
- **Fix tools are primitive**: jscpd has an experimental `--fix` flag (3-5% reduction). CodeScene ACE does single-function IDE-only refactoring. Neither runs tests to verify.
- **Claude Code plugins are detection-only**: kylebrodeur/codebase-analysis wraps jscpd + knip but doesn't fix. finereli/refactoring provides process guidance, not automation. Deslop is regex-based cleanup with no verification.
- **Nobody does end-to-end orchestration**: scan → prioritise → fix → verify → report.

The orchestration is the product.

## The Approach

A key research finding from CodeScene's FSE 2025 paper: **use deterministic analysis for detection, LLMs for fix generation**. LLMs are bad at finding refactoring opportunities (ChatGPT found only 28/180 in a controlled study) but good at executing them once told what to fix.

This shapes the architecture:

1. **Deterministic analysers** (Bun/JS) do the scanning — fast, zero tokens, reliable
2. **AI agents** (Claude) do targeted assessment on flagged items and generate fixes
3. **The project's own test suite** verifies fixes — rollback on failure

## Target Languages

Shipped with first-class rule support for:

1. **TypeScript/JavaScript** (primary — cleanest export/import model, highest AI coding density)
2. **Go**
3. **Python**
4. **C#**
5. **Java**

The engine is language-agnostic. Languages differ only in rule files (regex patterns) and one code path for Python's indent-based metrics. Adding a new language = adding a rule file. Community contributions welcome for languages beyond these five.

## Part of the "lazy" Series

This sits alongside:

- **lazy-dev** — Multi-agent task orchestration (builds features)
- **lazy-QA** — Test storm (verifies features work)
- **lazy-backlog** — JIRA/Confluence integration (manages work)
- **Context Guardian** — Context management and smart compression

lazy-refactor fills the gap between "code was written" and "code is maintainable." It can run after lazy-dev completes work, or independently on any codebase.

## What It Is NOT

- **Not a security scanner** — SonarQube, Semgrep, Snyk handle that
- **Not an accessibility auditor**
- **Not a CI/CD configuration tool**
- **Not a test writer** — lazy-QA handles that
- **Not framework-specific** — works on any codebase in the target languages
- **Not a vibe-coding-only tool** — handles any AI-generated (or human-generated) code quality issues

---

## The 15 Checks

### Common Checks (language-agnostic, work on all 5 languages)

#### 1. Dead Code
Exported symbols with zero references, orphaned files never imported anywhere, abandoned pivot code (AI started one approach, switched, left the old code behind).

**Detection:** Export/import cross-reference analysis.
- Parse all files for export statements (language-specific regex)
- Parse all files for import statements (language-specific regex)
- Set intersection: exports with zero matching imports = dead code candidates
- Filter: entry points (main files, index files), test files, config-referenced files
- Git enhancement: recently-added (`git log --diff-filter=A`) + zero references = high-confidence AI pivot debris

**Language notes:**
- TypeScript: `export function`, `export const`, `export class`, `export default`, `export { X }` / `import { X } from`, `import X from`, `require('X')`
- Go: Capitalised names = exported (`func [A-Z]`, `type [A-Z]`, `var [A-Z]`). Imports: `import "pkg"`, `import ( "pkg" )`
- Python: Everything at module level is implicitly exported. Use `__all__` if present, otherwise treat all top-level `def`/`class` as exports. Imports: `import X`, `from X import Y`
- C#: `public class`, `public static`, `public interface`. Imports: `using X;`
- Java: `public class`, `public static`, `public interface`. Imports: `import X.Y.Z;`

**Risk:** Python's implicit exports and dynamic nature mean higher false-positive rate. Score Python findings with lower confidence.

#### 2. Duplication
Near-duplicate functions or code blocks — the same logic with different variable names, or copy-pasted blocks with minor variations.

**Detection:** Rabin-Karp token hashing.
- Tokenize source files: split on whitespace + common operators/delimiters (`(){}[];,.<>+-*/=!&|?:`)
- Normalise: replace identifiers with `IDENT`, numbers with `NUM`, strings with `STR` — catches renamed-variable clones
- Compute rolling hash over sliding window of N tokens (configurable, default ~50)
- Group files by shared hashes: same hash in two locations = candidate duplicate
- Verify by comparing actual token sequences (eliminate hash collisions)
- Report: pairs of similar blocks with file paths, line ranges, similarity percentage

**Language notes:** Tokenization is language-agnostic (splitting on whitespace + operators works for all C-family syntax). Python's significant whitespace doesn't matter because we compare token sequences, not structure.

**Tuning:** Similarity threshold (default 80%?) will need iteration to balance false positives vs missed duplicates. Make configurable.

#### 3. Unused Imports and Dependencies
Import statements that reference unused symbols, and package dependencies declared but never used.

**Detection:**
- **Unused deps:** Parse package manifest (package.json / go.mod / requirements.txt / *.csproj / pom.xml) for declared dependencies. ripgrep the codebase for actual import/require/use of each dependency name. Declared but never imported = unused.
- **Unused imports within files:** Parse import statements, check if imported symbols appear in the rest of the file. Regex-based: find all imported names, grep within the file for usage.

**Language notes:**
- Go: the compiler already catches unused imports, so this is less valuable. Focus on unused dependencies in go.mod.
- Python: `import X` makes all of `X` available — harder to tell if sub-symbols are used. Focus on imports where the module name never appears after the import line.

#### 4. Cognitive Complexity
Functions that are too deeply nested, too heavily branched, or too long to understand.

**Detection:** Per-file metrics with heuristic scoring.
- Count nesting depth: track brace depth (or indent level for Python)
- Count branch points: if, else, switch/case, ternary (?:), && / ||
- Count loop constructs: for, while, do, foreach/range
- Compute score similar to SonarQube's cognitive complexity metric
- Flag files/functions above threshold (configurable, default: complexity > 15 or nesting > 4)

**Language notes:**
- TypeScript/Go/C#/Java: brace-counting for nesting depth
- Python: indent-level tracking (separate code path, ~50-80 lines of additional JS in the metrics engine)

**Approach:** Compute per-file aggregate complexity. Flag high-complexity files. The AI assessor can drill into specific functions on flagged files. This avoids the need to parse function boundaries deterministically.

#### 5. Long Files
Files over 300 lines (configurable threshold).

**Detection:** `find` + `wc -l`. Trivial.

**Enhancement:** Also detect long functions within flagged files — track consecutive lines between function markers. The AI assessor handles function-level decomposition suggestions.

#### 6. Comment Quality
Missing comments on complex code, excessive step-by-step AI comments that add no value, stale comments that don't match the code.

**Detection (deterministic):**
- Comment-to-code ratio per file
- Functions with zero comments/docstrings (above a complexity threshold — simple functions don't need comments)
- AI comment markers: `// Step 1:`, `// First, we...`, `// Now we need to...`, `// This function does...` patterns

**Detection (AI assessment):** For flagged files, the assessor checks:
- Are existing comments accurate (do they match what the code actually does)?
- Are comments explaining "what" instead of "why"?
- Are there complex sections with no explanation?

#### 7. Outdated Patterns
Using old libraries when modern alternatives exist, or using deprecated API patterns.

**Detection:**
- Known migration list (shipped as a JSON/JS data file per ecosystem):
  - JS/TS: moment.js → date-fns/dayjs, request → got/node-fetch, lodash (full) → lodash-es or native, callbacks → promises/async-await, var → const/let
  - Python: urllib2 → requests/httpx, optparse → argparse, old-style string formatting → f-strings, os.path → pathlib
  - Go: ioutil (deprecated in 1.16) → io/os, old error patterns
  - C#: WebClient → HttpClient, old async patterns → async/await
  - Java: Date/Calendar → java.time, Vector → ArrayList, Hashtable → HashMap
- Check dependency versions against known deprecation/migration paths
- AI assessor confirms and suggests specific migration approach

#### 8. Modularity / God Files
Files with too many concerns, too many exports, too many responsibilities.

**Detection (deterministic):**
- Files with > N exports (configurable, default 10)
- Files with > N imports (configurable, default 15)
- Files over 300 lines with multiple unrelated export groups
- High import fan-in (many other files depend on this one) combined with high export count

**Detection (AI assessment):** For flagged files, the assessor identifies:
- Distinct concerns/responsibilities within the file
- Suggested split strategy (which groups of functions/classes should become separate modules)

#### 9. Empty / Swallowed Error Handling
Error handling that hides bugs — empty catch blocks, logging-only error handling, discarded errors.

**Detection:** Language-specific regex patterns.
- TypeScript: `catch` followed by empty braces `{}`, `catch` with only `console.log`
- Go: `_ =` or `_ :=` (explicit error discard), `if err != nil { return nil }` (error swallowed without context)
- Python: bare `except: pass`, `except Exception: pass`, `except` with only `print`
- C#: `catch` followed by empty braces, `catch` with only `Console.WriteLine`
- Java: `catch` followed by empty braces, `catch` with only `e.printStackTrace()` or `System.out.println`

#### 10. Inconsistent Patterns
The same concern handled multiple different ways across the codebase — a hallmark of multi-session AI coding where each session uses its own approach.

**Detection:** AI-driven (but targeted).
- Deterministic pre-filter: identify concern categories (error handling, logging, data fetching, config access, validation) by keyword presence
- Group files by concern
- AI assessor compares approaches within each group and identifies fragmentation
- Example: "Error handling is done 4 different ways: try/catch with custom error class (12 files), try/catch with console.error (8 files), .catch() with toast notification (3 files), no error handling (5 files)"

#### 11. Debugging Leftovers
Debug statements, temporary logging, and debugging artifacts left in source code.

**Detection:** Language-specific regex patterns.
- TypeScript: `console.log`, `console.debug`, `console.info`, `console.warn`, `debugger` statement
- Go: `fmt.Println`, `fmt.Printf` (in non-CLI code), `log.Println` (without structured logging)
- Python: `print()` (in non-CLI code), `pdb.set_trace()`, `breakpoint()`, `import pdb`
- C#: `Console.WriteLine` (in non-console-app code), `Debug.WriteLine`, `Debugger.Break()`
- Java: `System.out.println`, `System.err.println`, `e.printStackTrace()`

**Note:** Need to distinguish intentional output (CLI tools, logging libraries) from debugging leftovers. Heuristic: if the project has a proper logging library in deps, raw print/println is likely a leftover.

#### 12. Hardcoded Values
Magic numbers, hardcoded configuration, and string literals that should be named constants or config-driven.

**Detection:**
- Numeric literals in logic (excluding 0, 1, -1, common sizes like 1024)
- Hardcoded URLs/endpoints: `http://` or `https://` literals in source (not config) files
- Hardcoded file paths
- Repeated string literals (same string appears 3+ times = should be a constant)
- Hardcoded timeouts, retry counts, limits

**Language notes:** Universal across all languages. Same regex patterns work everywhere.

#### 13. Over-Engineering / Unnecessary Abstraction
AI-generated code that creates wrapper classes, service layers, factory patterns, or other abstractions that add complexity without proportional value.

**Detection (deterministic pre-filter):**
- Files with very low usage (imported by only 1-2 other files) that contain only pass-through/delegation code
- Classes with only one method
- Interfaces/types with only one implementation
- Deeply nested directory structures relative to codebase size

**Detection (AI assessment):** For flagged candidates, the assessor evaluates:
- Does this abstraction earn its keep? Is it used enough to justify its existence?
- Is this a pass-through wrapper that could be eliminated?
- Would inlining this simplify the codebase?

### Language-Specific Checks

#### 14. Missing Cleanup / Resource Management
Code that acquires resources but doesn't properly release them.

**Detection:** Language-specific patterns.
- TypeScript: `useEffect` without return function (cleanup), `addEventListener` without corresponding `removeEventListener`, `setInterval`/`setTimeout` without cleanup
- Go: File/connection `Open()` without `defer Close()` (detectable when Open and Close are in same function with no defer)
- Python: `open()` without `with` statement (context manager)
- C#: `IDisposable` implementations without `using` statement
- Java: Resources opened without try-with-resources

**Note:** This is harder to detect deterministically in all cases. The scanner catches the obvious patterns; the AI assessor handles nuance.

#### 15. Full Library Imports
Importing entire libraries when only specific functions are needed, bloating bundle size.

**Detection:**
- TypeScript/JavaScript: `import X from 'library'` (default import of whole module) vs `import { specific } from 'library'`. Flag for known heavy libraries (lodash, rxjs, etc.)
- Python: `import X` when only `X.specific_thing` is used (minor concern due to different bundling model)
- Go/C#/Java: Not applicable (compilers/build systems handle this)

**Note:** Primarily a JS/TS concern. For other languages, this check is deprioritised or skipped.

---

## Architecture

### Design Principles

1. **Deterministic detection, AI-powered fixes.** The scan phase uses zero tokens. AI is only invoked for assessment of flagged candidates and fix generation.
2. **Language-agnostic engine, language-specific rules.** The engine doesn't know about languages. Rules are data files with regex patterns and thresholds.
3. **The project's test suite is the verification layer.** Fixes are only accepted if tests pass. Rollback on failure.
4. **Human in the loop for fixes.** The scan and report are automatic. Fixes require user approval (individually or in batches).

### Plugin Structure

```
lazy-refactor/
├── .claude-plugin/
│   └── manifest.json              — plugin manifest
├── agents/
│   ├── scanner.md                 — orchestrates scan, calls MCP tools, does targeted AI assessment
│   ├── fixer.md                   — makes targeted refactoring changes, runs tests, rolls back on failure
│   └── assessor.md                — deep AI analysis for modularity, comments, over-engineering, inconsistent patterns
├── commands/
│   ├── scan.md                    — /lazy-refactor scan [path] [--focus=duplicates,dead-code,...]
│   ├── report.md                  — /lazy-refactor report [--severity=high]
│   ├── fix.md                     — /lazy-refactor fix <id|all|critical|high> [--dry-run]
│   └── status.md                  — /lazy-refactor status
├── src/
│   ├── mcp/
│   │   └── server.js              — MCP server exposing analysis + state tools
│   ├── engine/
│   │   ├── pattern-scanner.js     — runs regex patterns against files via ripgrep
│   │   ├── metrics.js             — file/function-level measurements (size, complexity, ratios)
│   │   ├── cross-ref.js           — export/import analysis, dead code, unused deps
│   │   └── duplicates.js          — Rabin-Karp token hashing for clone detection
│   ├── rules/
│   │   ├── common.js              — checks that work on all languages (hardcoded values, long files, magic numbers)
│   │   ├── typescript.js          — TS/JS-specific patterns
│   │   ├── go.js                  — Go-specific patterns
│   │   ├── python.js              — Python-specific patterns
│   │   ├── csharp.js              — C#-specific patterns
│   │   ├── java.js                — Java-specific patterns
│   │   └── outdated-patterns.js   — known library migration paths per ecosystem
│   ├── scoring/
│   │   └── prioritizer.js         — scores findings by severity x confidence / risk
│   └── state/
│       └── findings.js            — persists scan results, tracks fix status
└── package.json
```

### Engine Components

#### pattern-scanner.js
Takes a list of rule objects and runs them against the codebase. Each rule is:

```js
{
  id: 'empty-catch-ts',
  severity: 'high',          // critical | high | medium | low
  category: 'error-handling', // maps to one of the 15 checks
  description: 'Empty catch block swallows errors silently',
  language: 'typescript',     // or 'common' for universal rules
  // Detection — one of:
  pattern: /catch\s*\([^)]*\)\s*\{\s*\}/,           // regex to match
  antiPattern: /ErrorBoundary|componentDidCatch/,     // if present in file, skip this rule
  filePattern: '**/*.{ts,tsx,js,jsx}',               // which files to scan
  exclude: ['**/*.test.*', '**/*.spec.*'],           // files to skip
  // Reporting
  suggestion: 'Add error handling logic or propagate the error',
  fixable: true               // whether the fixer agent can auto-fix this
}
```

The scanner runs ripgrep (or grep) with each pattern, collects matches with file paths and line numbers, applies exclusions and anti-patterns, and returns structured findings.

#### metrics.js
Computes per-file metrics:
- Line count
- Nesting depth (brace-tracking for C-family, indent-tracking for Python)
- Branch point count (if/else/switch/ternary/&&/||)
- Comment-to-code ratio
- Export count
- Import count
- Approximate cognitive complexity score (weighted combination of nesting + branches + length)

Returns files that exceed configured thresholds as findings.

#### cross-ref.js
Builds an export/import graph:
1. Scan all source files for export statements (language-specific regex)
2. Scan all source files for import statements (language-specific regex)
3. Cross-reference: exported symbols with zero matching imports = dead code candidates
4. Check package manifest for declared deps, compare against actual imports = unused deps
5. Within files: imported symbols that never appear after the import line = unused imports
6. Optional git correlation: `git log --diff-filter=A --since="30 days"` to identify recently-added code that's now dead (abandoned AI pivots)

Returns orphaned files, unused exports, unused deps, unused imports as findings.

#### duplicates.js
Rabin-Karp token hashing for clone detection:
1. **Tokenize:** Split each source file into tokens by whitespace + operators. Universal tokenizer works for all C-family languages.
2. **Normalise:** Replace identifiers with `IDENT`, numeric literals with `NUM`, string literals with `STR`. This catches renamed-variable clones (Type-2 in clone detection taxonomy).
3. **Hash:** Compute rolling hash (Rabin-Karp) over sliding window of N tokens (configurable, default 50).
4. **Match:** Hash table lookup — same hash in two locations = candidate duplicate.
5. **Verify:** Compare actual token sequences to eliminate hash collisions. Compute similarity percentage.
6. **Report:** Pairs of similar blocks with file paths, line ranges, similarity score, estimated token count.

Performance: O(n) per file for hashing, O(1) hash table lookup. Should handle codebases of 1000+ files in seconds.

### MCP Tools

Exposed by the MCP server for use by agents and commands:

**Scan tools:**
- `run_scan(path, options)` — runs all analysers, returns raw findings
- `scan_duplicates(path, min_tokens, threshold)` — just the duplicate detector
- `scan_dead_code(path)` — just the cross-reference analyser
- `scan_metrics(path, thresholds)` — just the metrics engine
- `scan_patterns(path, categories)` — just the pattern scanner for specific rule categories

**State tools:**
- `get_findings(filter)` — retrieve findings, filterable by severity/category/language/status
- `get_finding(id)` — detail for a specific finding
- `update_finding(id, status, notes)` — mark as fixed/ignored/in-progress/false-positive
- `get_summary()` — overall health metrics and category breakdown

**Configuration tools:**
- `get_config()` — current thresholds and enabled checks
- `update_config(overrides)` — adjust thresholds, enable/disable specific checks

### Agents

#### scanner.md
System prompt for the scan orchestration agent. Responsibilities:
- Call MCP scan tools to run deterministic analysis
- Review findings and do targeted AI assessment on flagged candidates (modularity, comment accuracy, over-engineering, inconsistent patterns)
- Confirm or dismiss deterministic findings that need AI judgment
- Store final findings via MCP state tools
- Present summary report to user

#### fixer.md
System prompt for the fix agent. Responsibilities:
- Read finding details from MCP state
- Make targeted, minimal code changes to address the finding
- Run the project's test suite after each change
- If tests pass: report success, mark finding as fixed
- If tests fail: revert the change, report failure with details
- Never make changes beyond the scope of the specific finding
- Prefer the simplest fix that addresses the issue

#### assessor.md
System prompt for the AI assessment agent. Responsibilities:
- Deep analysis of files flagged by deterministic checks
- Evaluate modularity: identify distinct concerns in god files, suggest split strategy
- Evaluate comment quality: are comments accurate, are they "what" vs "why"
- Evaluate over-engineering: does an abstraction earn its keep
- Identify inconsistent patterns: group similar code, identify the canonical approach
- Return structured assessments that feed into the prioritiser

### Scoring / Prioritisation

Each finding gets a composite score:

```
score = severity_weight × confidence × (1 / risk)
```

Where:
- **severity_weight:** critical=4, high=3, medium=2, low=1
- **confidence:** 0.0-1.0, how certain we are this is a real issue (deterministic checks get 0.9+, AI-assessed findings get 0.6-0.9 depending on clarity)
- **risk:** how risky is the fix? (removing dead code=low risk, restructuring a god file=higher risk)

Findings presented to user in score order, grouped by severity tier.

### Pipeline Flow

```
/lazy-refactor scan [path]
       │
       ▼
  DISCOVER (deterministic — seconds, zero tokens)
  ├── pattern-scanner runs all enabled rules
  ├── metrics engine computes file/function metrics
  ├── cross-ref engine builds export/import graph
  └── duplicates engine runs Rabin-Karp analysis
       │
       ▼
  ASSESS (AI — moderate tokens, targeted)
  ├── assessor agent reviews flagged candidates (~10-20 items)
  ├── confirms/rejects findings, adds context
  └── identifies inconsistent patterns, modularity issues
       │
       ▼
  PRIORITISE (deterministic — milliseconds)
  ├── score each finding
  └── rank and group by severity tier
       │
       ▼
  REPORT (presented to user)
       │
       ▼
/lazy-refactor fix <id|all|critical|high>
       │
       ▼
  EXECUTE (per finding — tokens per fix)
  ├── fixer agent reads finding details
  ├── makes targeted change
  ├── runs test suite
  ├── pass → mark fixed
  └── fail → rollback, flag for manual review
       │
       ▼
  SUMMARY
  ├── what was fixed
  ├── what failed
  └── updated health metrics
```

### Language Auto-Detection

The engine detects the project's language(s) from project markers:

| Marker | Language | Rule file loaded |
|---|---|---|
| `package.json` or `tsconfig.json` | TypeScript/JavaScript | `typescript.js` |
| `go.mod` | Go | `go.js` |
| `requirements.txt`, `pyproject.toml`, `setup.py` | Python | `python.js` |
| `*.csproj`, `*.sln` | C# | `csharp.js` |
| `pom.xml`, `build.gradle` | Java | `java.js` |

Multiple languages can be detected in the same project (e.g., a monorepo with a TS frontend and Go backend). All matching rule files are loaded. Common rules are always loaded.

### Configuration

Users can override defaults via a `.lazy-refactor.json` in the project root or via MCP tool calls:

```json
{
  "thresholds": {
    "maxFileLines": 300,
    "maxComplexity": 15,
    "maxNesting": 4,
    "maxExportsPerFile": 10,
    "duplicateMinTokens": 50,
    "duplicateSimilarity": 0.80
  },
  "exclude": [
    "vendor/**",
    "generated/**",
    "*.generated.*"
  ],
  "disabledChecks": [],
  "languages": "auto"
}
```

### Relationship to lazy-dev

Standalone plugin. Does NOT require lazy-dev.

If lazy-dev is installed, lazy-refactor can optionally dispatch fix tasks through lazy-dev's agent infrastructure (with ralph-gate quality verification). If lazy-dev is not installed, lazy-refactor uses its own simpler execution loop (single agent, test-and-commit).

Detection should check if lazy-dev MCP tools are available at startup and adapt accordingly.

---

## Technical Stack

- **Runtime:** Bun
- **Language:** Raw JavaScript (no TypeScript) — consistent with the lazy-dev plugin series
- **Linter/formatter:** Biome
- **Tests:** `bun test`
- **Package manager:** Bun
- **Platforms:** WSL Ubuntu, macOS
- **External dependencies:** None required. The plugin is self-contained. Shell tools (grep, ripgrep, find, wc, git) are expected to be available on the system.
- **Optional enhancement:** If jscpd is available (`npx jscpd` or globally installed), the duplicate detector can delegate to it for potentially better results. The built-in Rabin-Karp detector is the default.

---

## Phasing

### Phase 1 — MVP
- Engine: pattern-scanner, metrics, cross-ref, duplicates
- Rules: common + TypeScript/JavaScript
- Commands: scan, report, fix (single finding), status
- Agents: scanner, fixer (basic)
- State: findings storage
- 10 common checks working end-to-end

### Phase 2 — Language Expansion + AI Assessment
- Rules: Go, Python
- Agent: assessor (modularity, comments, over-engineering, inconsistent patterns)
- Batch fix: `fix all --severity=high`
- Health tracking over time (before/after metrics per scan)

### Phase 3 — Full Coverage
- Rules: C#, Java
- Custom rule support (user-defined rules in project config)
- lazy-dev integration (optional dispatch through lazy-dev agents)
- Community rule contribution mechanism

---

## Research Sources

Key papers and data that informed this design:

- GitClear AI Copilot Code Quality 2025 Research — 211M lines analysed, duplication up 4-8x, refactoring down 60%
- CodeRabbit State of AI vs Human Code Generation Report — 470 PRs, 1.7x more issues in AI code
- CodeScene ACE FSE 2025 paper (arXiv:2507.03536) — deterministic detection + LLM fixes is the right architecture
- "Debt Behind the AI Boom" (arXiv:2603.28592) — 302,600 AI commits, 110,000+ unresolved technical debt issues
- LLM refactoring study — ChatGPT found only 28/180 refactoring opportunities (LLMs are bad at detection, good at execution)
- The New Stack: "What's Missing With AI-Generated Code? Refactoring"
- Google DORA 2024: 25% increase in AI usage → 7.2% decrease in delivery stability
- IBM Research: LLM review alone catches 45% of issues; LLM + deterministic analysis catches 94%

Existing tools researched:
- jscpd (duplicate detection, 223 languages, has MCP server and AI reporter)
- Drift / sauremilk (architectural erosion detection, GitHub Action, detection only)
- knip (JS/TS dead code), Vulture (Python dead code), deadcode (Go dead code)
- CodeScene ACE (single-function IDE refactoring)
- CircleCI Chunk (CI-embedded refactoring)
- Sourcery AI (Python suggestions)
- kylebrodeur/codebase-analysis (Claude Code plugin, detection only)
- finereli/refactoring (Claude Code plugin, process guidance only)
- Deslop (Claude Code skill, regex cleanup, no verification)
