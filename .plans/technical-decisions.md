# lazy-refactor — Technical Decisions and Rationale

This document captures the key technical decisions made during the design phase and WHY each choice was made. An implementing LLM should follow these decisions unless there is a clear reason to deviate.

---

## Decision 1: Deterministic Detection, AI Fixes

**Decision:** Use deterministic analysis (regex, Rabin-Karp hashing, export/import cross-reference) for finding issues. Use Claude agents only for AI assessment of ambiguous findings and for generating fixes.

**Why:** CodeScene's FSE 2025 paper (arXiv:2507.03536) demonstrated that deterministic detection + LLM fixes is significantly more effective than LLM-only approaches. A separate study showed ChatGPT found only 28 out of 180 known refactoring opportunities — LLMs are bad at detection. IBM Research showed LLM review alone catches 45% of issues; LLM + deterministic analysis catches 94%.

**Implication:** The scan phase should cost zero tokens. AI is invoked only on the filtered, high-value subset of findings (~10-20 items out of potentially hundreds of raw detections).

---

## Decision 2: Language-Agnostic Engine + Language-Specific Rule Files

**Decision:** The engine code (pattern-scanner, metrics, cross-ref, duplicates) is language-agnostic. Languages are represented as data files containing regex patterns, thresholds, and known migration paths.

**Why:** We target 5 languages (TypeScript, Go, Python, C#, Java). Building language-specific engine code for each would be 5x the maintenance. The rule-as-data approach means adding a language is adding a file, not changing the engine. The engine can also be tested independently of any language rules.

**Implication:** The engine should never contain `if (language === 'go')` branches. All language-specific behaviour comes from the rule files. The one exception is Python's indent-based nesting detection in the metrics engine, which requires a different code path from brace-counting.

---

## Decision 3: No External Dependencies Required

**Decision:** The plugin ships with zero external dependencies. All analysis runs as self-contained Bun/JS code using shell tools (grep, ripgrep, find, wc, git) that are expected to be available.

**Why:** External deps (jscpd, tree-sitter, knip) add installation friction, version management, and potential breakage. The lazy-dev plugin is self-contained and that's proven to be the right approach. Our own Rabin-Karp implementation handles duplication detection well enough for the use case.

**Exception:** If ripgrep (`rg`) is not available, fall back to `grep`. If jscpd happens to be installed, the duplicate detector MAY delegate to it for potentially better results, but the built-in detector is the default.

**Implication:** No `npm install` / `bun add` for analysis tools. Everything we need is either in our own JS code or standard shell utilities.

---

## Decision 4: No Serena / LSP Dependency

**Decision:** The plugin does NOT depend on Serena or any LSP server. Export/import analysis uses regex-based parsing.

**Why:** Serena is an external MCP server that users may or may not have installed. We can't ship it with the plugin or require it. Regex-based export/import parsing catches the high-value cases (orphaned files, unused exports, unused dependencies) well enough. The research confirmed that import/export analysis alone catches the majority of real-world dead code.

**Trade-off:** We miss dynamic dispatch, reflection-based usage, and some edge cases. Python's implicit exports mean higher false-positive rates. These are acceptable trade-offs — findings with lower confidence get lower scores in the prioritiser.

**Enhancement:** If Serena IS available in the user's session, the scanner agent can opportunistically use `find_referencing_symbols` for more precise dead code detection. But this is an optional enhancement, not a requirement.

---

## Decision 5: Rabin-Karp for Duplicate Detection (Not jscpd)

**Decision:** Implement our own Rabin-Karp token hashing for duplicate detection rather than depending on jscpd.

**Why:** jscpd is an npm package that would need to be installed. Our own implementation is ~200-300 lines of JS, runs in Bun, and gives us full control over tokenisation, normalisation, and threshold tuning. The algorithm is well-understood and the research (SourcererCC achieved 86-100% recall with token-based approaches) confirms it works.

**How it works:**
1. Tokenize: split source on whitespace + operators/delimiters
2. Normalise: identifiers → IDENT, numbers → NUM, strings → STR
3. Rolling hash: Rabin-Karp over sliding window of N tokens
4. Match: hash table lookup for shared hashes
5. Verify: compare actual token sequences to eliminate collisions

**Tuning parameters to expose:**
- `minTokens`: minimum window size (default 50)
- `similarity`: minimum similarity threshold (default 0.80)
- Both configurable via `.lazy-refactor.json`

---

## Decision 6: Per-File Complexity, Not Per-Function

**Decision:** Compute aggregate complexity metrics at the file level, not the function level. Flag high-complexity files. Let the AI assessor drill into specific functions.

**Why:** Detecting function boundaries deterministically across 5 languages (especially Python with its indent-based structure) adds significant complexity. Per-file metrics (total nesting depth, total branch count, line count, export count) are sufficient to identify problem areas. The AI assessor — which already understands all languages — can then identify the specific problematic functions within flagged files.

**Implication:** The metrics engine does NOT need to parse function boundaries. It processes files line-by-line, tracking cumulative nesting depth, branch points, and other signals. This keeps the engine simple and language-agnostic (with the one exception of Python indent tracking vs brace tracking).

---

## Decision 7: Human-in-the-Loop for Fixes

**Decision:** The scan and report are automatic. Fixes always require user approval — either individually (`fix 3`) or in batches (`fix all --severity=high`).

**Why:** Automated refactoring without human approval is too risky. Even with test verification, refactoring can change behaviour in ways tests don't cover. The user should see what's being proposed and decide what to fix. This also controls token spend — the user decides how much budget to allocate to fixes.

**Implication:** The `fix` command should clearly show what it's about to do before doing it. A `--dry-run` flag should show the proposed approach without making changes.

---

## Decision 8: Test Suite as Verification Layer

**Decision:** After each fix, run the project's test suite. Pass = accept the fix. Fail = rollback.

**Why:** This is the only reliable way to verify refactoring didn't break anything. Static analysis can catch syntax errors but not behavioural changes. The test suite is the source of truth.

**Implication:** The fixer agent needs to detect and run the project's test command. Auto-detection from:
- `package.json` scripts.test → `bun test` or `npm test`
- `go.mod` → `go test ./...`
- `pytest.ini` / `pyproject.toml` / `setup.cfg` → `pytest`
- `*.csproj` → `dotnet test`
- `pom.xml` → `mvn test` / `build.gradle` → `gradle test`

If no test suite is detected, the fixer should warn the user and proceed with caution (or skip verification).

---

## Decision 9: Standalone Plugin, Optional lazy-dev Integration

**Decision:** lazy-refactor is a standalone Claude Code plugin. It does NOT require lazy-dev. But if lazy-dev is installed, it can optionally use lazy-dev's agent infrastructure for fix execution.

**Why:** Not all users will have lazy-dev. lazy-refactor should be independently useful. But for users who do have lazy-dev, the integration provides better orchestration (ralph-gate verification, multi-agent dispatch, worktree isolation).

**Detection:** At startup, check if lazy-dev MCP tools are available. If so, offer the option to dispatch fix tasks through lazy-dev. If not, use the built-in fixer agent.

---

## Decision 10: Raw JavaScript, Bun Runtime

**Decision:** All plugin code is raw JavaScript (no TypeScript), using Bun as the runtime.

**Why:** Consistency with the lazy-dev plugin series. The user's stack preference. Bun is fast enough for the analysis workloads (tokenisation, hashing, regex scanning). No build step needed.

**Implication:** No TypeScript types in source code. Use JSDoc for documentation where needed. Use Biome for linting/formatting.

---

## Decision 11: Findings Stored as JSON State

**Decision:** Scan results are persisted to a JSON file in a `.lazy-refactor/` directory within the project (or a temp directory). Findings have stable IDs so they can be referenced across commands.

**Why:** The scan and fix commands run in separate sessions. Findings need to persist between them. JSON is simple, inspectable, and requires no dependencies.

**Structure:**
```json
{
  "scanId": "2026-05-20T14:30:00Z",
  "path": "src/",
  "findings": [
    {
      "id": "f-001",
      "check": "duplicate",
      "severity": "high",
      "confidence": 0.92,
      "score": 2.76,
      "status": "open",
      "description": "Near-duplicate code blocks",
      "locations": [
        { "file": "src/utils/format.js", "startLine": 12, "endLine": 58 },
        { "file": "src/helpers/stringify.js", "startLine": 8, "endLine": 55 }
      ],
      "suggestion": "Consolidate into single utility function",
      "similarity": 0.89,
      "fixable": true
    }
  ],
  "summary": {
    "totalFindings": 127,
    "bySeverity": { "critical": 0, "high": 12, "medium": 45, "low": 70 },
    "byCategory": { "duplicate": 17, "dead-code": 23, "complexity": 31 }
  }
}
```

---

## Decision 12: Python Indent Tracking

**Decision:** The metrics engine has a separate code path for Python that tracks nesting via indent level instead of brace depth.

**Why:** Python uses significant whitespace. Brace-counting doesn't work. This is the ONE place where the engine needs language-specific logic.

**How:** Track the indent level of each line (count leading spaces/tabs, normalise tabs to 4 spaces). Nesting depth = indent level / indent unit. Branch points still detected by keyword matching (if, elif, else, for, while, try, except, with).

**Scope:** This is ~50-80 lines of additional code in the metrics engine, behind a `if (language === 'python')` check. This is the only permitted language-specific branch in engine code.
