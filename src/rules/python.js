/** @type {Array<{
 *   id: string,
 *   severity: string,
 *   category: string,
 *   description: string,
 *   language: string,
 *   pattern: string,
 *   antiPattern: string|null,
 *   filePattern: string,
 *   exclude: string[],
 *   suggestion: string,
 *   fixable: boolean
 * }>}
 */
const rules = [
  {
    id: "bare-except-py",
    severity: "high",
    category: "error-handling",
    description:
      "Bare except clause catches all exceptions including SystemExit and KeyboardInterrupt",
    language: "python",
    pattern: "\\bexcept\\s*:",
    antiPattern: null,
    filePattern: "**/*.py",
    exclude: ["**/*_test.py", "**/test_*.py", "**/tests/**"],
    suggestion:
      "Catch specific exceptions: except ValueError: or at minimum except Exception:. Never use bare except:.",
    fixable: true,
  },
  {
    id: "print-debug-py",
    severity: "medium",
    category: "debugging-leftovers",
    description: "print() used for debug output in non-CLI code",
    language: "python",
    pattern: "^\\s*print\\s*\\(",
    antiPattern: null,
    filePattern: "**/*.py",
    exclude: [
      "**/*_test.py",
      "**/test_*.py",
      "**/tests/**",
      "**/*cli*",
      "**/*command*",
      "**/__main__.py",
      "**/train*",
      "**/pipeline*",
      "**/trainer*",
    ],
    suggestion:
      "Replace print() with structured logging using the `logging` module. Use `logging.debug()` for debug output that can be filtered by log level.",
    fixable: true,
  },
  {
    id: "pdb-debug-py",
    severity: "critical",
    category: "debugging-leftovers",
    description: "pdb/ipdb debugger trace left in code — will pause execution in production",
    language: "python",
    pattern:
      "(?:import\\s+pdb\\s*;\\s*pdb\\.set_trace\\(\\)|import\\s+ipdb\\s*;\\s*ipdb\\.set_trace\\(\\)|breakpoint\\s*\\(\\))",
    antiPattern: null,
    filePattern: "**/*.py",
    exclude: ["**/*_test.py", "**/test_*.py", "**/tests/**"],
    suggestion:
      "Remove all debugger breakpoints before committing. Use IDE breakpoints or conditional breakpoints in development instead.",
    fixable: true,
  },
  {
    id: "open-without-context-manager-py",
    severity: "high",
    category: "resource-leaks",
    description:
      "open() called without a `with` statement — file handle may not be closed on exception",
    language: "python",
    pattern: "\\bopen\\s*\\(",
    antiPattern: "with\\s+open\\s*\\(",
    filePattern: "**/*.py",
    exclude: ["**/*_test.py", "**/test_*.py", "**/tests/**"],
    suggestion:
      "Use a context manager: `with open('file.txt', 'r') as f:` — this guarantees the file is closed even if an exception occurs.",
    fixable: true,
  },
  {
    id: "percent-string-format-py",
    severity: "low",
    category: "deprecated-patterns",
    description: "Old-style % string formatting — use f-strings for clarity and performance",
    language: "python",
    pattern: "(?:\"[^\"]*%[sdifr][^\"]*\"|'[^']*%[sdifr][^']*')\\s*%\\s*\\(",
    antiPattern: null,
    filePattern: "**/*.py",
    exclude: ["**/*_test.py", "**/test_*.py", "**/tests/**", "**/migrations/**"],
    suggestion:
      "Replace `'Hello %s' % name` with f-strings: `f'Hello {name}'`. F-strings are faster and less error-prone.",
    fixable: true,
  },
  {
    id: "str-format-method-py",
    severity: "low",
    category: "deprecated-patterns",
    description: ".format() string formatting — prefer f-strings (Python 3.6+)",
    language: "python",
    pattern: "(?:\"[^\"]*\\{[^}]*\\}[^\"]*\"|'[^']*\\{[^}]*\\}[^']*')\\.format\\s*\\(",
    antiPattern: null,
    filePattern: "**/*.py",
    exclude: ["**/*_test.py", "**/test_*.py", "**/tests/**", "**/migrations/**"],
    suggestion:
      "Replace `'Hello {}'.format(name)` with f-strings: `f'Hello {name}'`. F-strings are more readable and performant.",
    fixable: true,
  },
  {
    id: "os-path-instead-of-pathlib-py",
    severity: "low",
    category: "deprecated-patterns",
    description:
      "os.path used instead of pathlib.Path — pathlib is the modern, object-oriented API",
    language: "python",
    pattern:
      "os\\.path\\.(?:join|exists|dirname|basename|splitext|abspath|expanduser|isfile|isdir)\\s*\\(",
    antiPattern: null,
    filePattern: "**/*.py",
    exclude: ["**/*_test.py", "**/test_*.py", "**/tests/**"],
    suggestion:
      "Use pathlib.Path: os.path.join(a,b)→Path(a)/b, os.path.exists(p)→Path(p).exists(), os.path.dirname(p)→Path(p).parent, os.path.basename(p)→Path(p).name.",
    fixable: true,
  },
  {
    id: "mutable-default-arg-py",
    severity: "high",
    category: "correctness",
    description: "Mutable default argument — list/dict/set defaults are shared across all calls",
    language: "python",
    pattern: "def\\s+\\w+\\s*\\([^)]*=\\s*(?:\\[\\]|\\{\\}|set\\(\\))",
    antiPattern: null,
    filePattern: "**/*.py",
    exclude: ["**/*_test.py", "**/test_*.py", "**/tests/**"],
    suggestion:
      "Use None as default and create the mutable object inside the function: def foo(items=None): items = items or []",
    fixable: true,
  },
  {
    id: "wildcard-import-py",
    severity: "medium",
    category: "maintainability",
    description: "Wildcard import pollutes the namespace and makes dependencies unclear",
    language: "python",
    pattern: "from\\s+\\S+\\s+import\\s+\\*",
    antiPattern: null,
    filePattern: "**/*.py",
    exclude: ["**/*_test.py", "**/test_*.py", "**/tests/**", "**/__init__.py"],
    suggestion:
      "Import specific names: from module import func1, func2. Use __all__ in the source module to control what * exports.",
    fixable: true,
  },
  {
    id: "global-keyword-py",
    severity: "medium",
    category: "maintainability",
    description:
      "global keyword used — mutating global state makes code hard to test and reason about",
    language: "python",
    pattern: "^\\s*global\\s+\\w+",
    antiPattern: null,
    filePattern: "**/*.py",
    exclude: ["**/*_test.py", "**/test_*.py", "**/tests/**"],
    suggestion:
      "Pass state as function parameters or use a class to encapsulate shared state instead of global variables.",
    fixable: true,
  },
];

export default rules;
