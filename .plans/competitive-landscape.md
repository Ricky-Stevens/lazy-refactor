# lazy-refactor — Competitive Landscape

This document summarises what exists in the market and how lazy-refactor differentiates. An implementing LLM should understand what NOT to replicate (because it exists) and what the unique value proposition is.

---

## Direct Competitors (Claude Code Plugins)

### kylebrodeur/codebase-analysis
- **What it does:** Wraps jscpd (duplicates), knip (dead code), dependency-cruiser (architecture) into a Claude Code plugin with an orchestrator skill
- **Limitation:** Detection only. Finds dead code and duplicates but does not fix them.
- **Node.js/Next.js/React focused**
- **Our differentiator:** We detect AND fix with test verification. We support 5 languages. We have a prioritisation layer.

### finereli/refactoring
- **What it does:** Disciplined refactoring plugin based on Fowler/Feathers principles. Analysis-first, identifies code smells, prioritises by impact (80/20). Multi-language (Python, TS, Go, Dart).
- **Limitation:** Guidance-oriented — structures the refactoring process but Claude does the actual work in a conversational loop. No independent scanning, no batch mode, no automated fix pipeline.
- **Our differentiator:** We have deterministic automated scanning (zero tokens), a persistent findings database, and an automated fix pipeline with test verification.

### Deslop (Claude Code skill)
- **What it does:** Uses regex patterns, multi-pass analysers, and AST-based repo-mapping to clean up AI-generated code. Categorises findings by certainty and severity.
- **Limitation:** Regex-based cleanup with no test verification. Narrow focus on "slop" patterns.
- **Our differentiator:** Broader scope (15 checks vs slop-specific patterns), test verification, prioritised findings, language-specific rules.

### AI Code Slop Remover (Claude Code skill)
- **What it does:** Strips verbose comments, excessive try-catch blocks, styling inconsistencies.
- **Limitation:** Very narrow, pattern-matching only.
- **Our differentiator:** Comprehensive quality tool, not just comment stripping.

---

## Detection-Only Tools (Not Claude Code Plugins)

### Drift (sauremilk/drift)
- **What it does:** Deterministic static analyser for architectural erosion caused by AI-generated code. Tree-sitter + call graphs. 45+ CLI commands, 50 MCP tools, 9 languages, Rust core. GitHub Action available.
- **Limitation:** Detection and enforcement only. No remediation. No auto-fix.
- **Our differentiator:** We fix what we find. Drift tells you what's wrong; lazy-refactor tells you AND fixes it.

### jscpd
- **What it does:** Token-based duplicate detection. 223 languages. Has an MCP server. AI reporter for LLM-friendly output. Experimental `--fix` flag.
- **Limitation:** Duplicate detection only (not dead code, complexity, patterns, etc.). The `--fix` flag achieves only 3-5% reduction and is experimental.
- **Our differentiator:** jscpd is one input to our pipeline. We add 14 more checks, prioritisation, and AI-powered fix generation with verification.

### knip
- **What it does:** Dead code detection for JS/TS. Builds complete module graph from entry points. ~150 framework plugins.
- **Limitation:** JS/TS only. Detection only.
- **Our differentiator:** Multi-language. Detection + fix. Part of a broader quality pipeline.

### SonarQube
- **What it does:** Comprehensive code quality platform. 30+ languages. Rules for bugs, vulnerabilities, code smells, complexity.
- **Limitation:** Detection and reporting only. No automated fix. Requires server infrastructure. Enterprise-priced.
- **Our differentiator:** We run locally as a Claude Code plugin. We fix what we find. No infrastructure needed.

---

## Fix Tools (Not Detection)

### CodeScene ACE
- **What it does:** Uses deterministic CodeHealth metric for detection, LLMs for fix generation. Built-in self-validation.
- **Limitation:** Single-function, IDE-only (VS Code, JetBrains). No batch mode. No "scan the whole codebase" capability. Limited language support (Java, JS, TS, C#). Does not run the project's test suite — uses internal heuristic validation.
- **Our differentiator:** Full codebase scanning. Batch fix mode. Test suite verification. CLI/Claude Code native.

### CircleCI Chunk
- **What it does:** CI-embedded refactoring agent. Scans repo for code smells, runs test suite to validate.
- **Limitation:** Tied to CircleCI. Enterprise product. Reactive (runs in CI), not on-demand.
- **Our differentiator:** Runs on-demand from Claude Code. No CI vendor lock-in.

### Gitar AI
- **What it does:** "Healing engine" — fixes CI failures (lint, tests, builds). Multi-language. Enterprise scale.
- **Limitation:** Reactive only — fixes things that are already broken. Does not scan for refactoring opportunities.
- **Our differentiator:** Proactive scanning. Finds issues before they break CI.

---

## The Unique Position

No existing tool does all four steps: **detect → prioritise → fix → verify**.

| Tool | Detect | Prioritise | Fix | Verify |
|---|---|---|---|---|
| SonarQube | Yes | Yes | No | No |
| Drift | Yes | No | No | No |
| jscpd | Yes (dupes only) | No | Experimental | No |
| knip | Yes (dead code, JS only) | No | No | No |
| CodeScene ACE | Yes | Yes | Yes (single function) | Heuristic only |
| CircleCI Chunk | Yes | No | Yes | Yes (CI only) |
| kylebrodeur/codebase-analysis | Yes | No | No | No |
| finereli/refactoring | Guided | No | Guided | No |
| **lazy-refactor** | **Yes** | **Yes** | **Yes (batch)** | **Yes (test suite)** |

The orchestration — particularly the combination of deterministic detection, AI-powered fixes, and test-suite verification — is what makes lazy-refactor novel.
