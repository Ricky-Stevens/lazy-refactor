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
    id: "empty-catch-cs",
    severity: "high",
    category: "error-handling",
    description: "Empty catch block — exception is silently swallowed",
    language: "csharp",
    pattern: "catch\\s*(?:\\([^)]*\\))?\\s*\\{\\s*\\}",
    antiPattern: "when\\s*\\(",
    filePattern: "**/*.cs",
    exclude: ["**/*.Tests.*", "**/*Test.cs", "**/*Tests.cs", "**/obj/**", "**/bin/**"],
    suggestion:
      "Handle exceptions meaningfully: log with ILogger and re-throw, or wrap with a domain-specific exception. An empty catch hides failures.",
    fixable: false,
  },
  {
    id: "sync-over-async-cs",
    severity: "high",
    category: "concurrency",
    description:
      ".Result or .GetAwaiter().GetResult() blocks the calling thread — deadlock risk in async contexts",
    language: "csharp",
    pattern: "(?:\\.Result\\b|\\.GetAwaiter\\s*\\(\\s*\\)\\.GetResult\\s*\\()",
    antiPattern: null,
    filePattern: "**/*.cs",
    exclude: ["**/*.Tests.*", "**/*Test.cs", "**/*Tests.cs", "**/obj/**", "**/bin/**"],
    suggestion:
      "Use await instead of .Result or .GetAwaiter().GetResult(). If you must block, use .ConfigureAwait(false) to avoid deadlocks.",
    fixable: false,
  },
  {
    id: "console-writeline-debug-cs",
    severity: "medium",
    category: "debugging-leftovers",
    description: "Console.WriteLine used for debug output — should use ILogger in production code",
    language: "csharp",
    pattern: "Console\\.(?:Write(?:Line)?|Error\\.Write(?:Line)?)\\s*\\(",
    antiPattern: null,
    filePattern: "**/*.cs",
    exclude: [
      "**/*.Tests.*",
      "**/*Test.cs",
      "**/*Tests.cs",
      "**/obj/**",
      "**/bin/**",
      "**/Program.cs",
    ],
    suggestion:
      "Replace Console.WriteLine with ILogger calls (LogInformation, LogDebug, LogError). Console output bypasses log level filtering and structured logging.",
    fixable: false,
  },
  {
    id: "debug-writeline-cs",
    severity: "medium",
    category: "debugging-leftovers",
    description: "Debug.WriteLine or System.Diagnostics.Debug used in production code",
    language: "csharp",
    pattern: "(?:System\\.Diagnostics\\.)?Debug\\.(?:Write(?:Line)?|Assert|Print)\\s*\\(",
    antiPattern: null,
    filePattern: "**/*.cs",
    exclude: ["**/*.Tests.*", "**/*Test.cs", "**/*Tests.cs", "**/obj/**", "**/bin/**"],
    suggestion:
      "Replace Debug.WriteLine with ILogger. Debug.* calls are stripped in Release builds — use ILogger for consistent structured logging.",
    fixable: false,
  },
  {
    id: "debugger-break-cs",
    severity: "critical",
    category: "debugging-leftovers",
    description: "Debugger.Break() left in source code — will pause execution in production",
    language: "csharp",
    pattern: "Debugger\\.(?:Break|Launch)\\s*\\(",
    antiPattern: null,
    filePattern: "**/*.cs",
    exclude: ["**/*.Tests.*", "**/*Test.cs", "**/*Tests.cs", "**/obj/**", "**/bin/**"],
    suggestion: "Remove Debugger.Break() before committing. Use IDE breakpoints instead.",
    fixable: true,
  },
  {
    id: "webclient-deprecated-cs",
    severity: "medium",
    category: "deprecated-patterns",
    description:
      "WebClient used instead of HttpClient — WebClient is deprecated and lacks async support",
    language: "csharp",
    pattern: "new\\s+WebClient\\s*\\(",
    antiPattern: null,
    filePattern: "**/*.cs",
    exclude: ["**/*.Tests.*", "**/*Test.cs", "**/*Tests.cs", "**/obj/**", "**/bin/**"],
    suggestion:
      "Replace WebClient with HttpClient (injected via IHttpClientFactory). HttpClient supports async/await, connection pooling, and is the modern .NET HTTP API.",
    fixable: false,
  },
  {
    id: "thread-sleep-cs",
    severity: "medium",
    category: "deprecated-patterns",
    description:
      "Thread.Sleep used in potentially async context — blocks the thread instead of yielding",
    language: "csharp",
    pattern: "Thread\\.Sleep\\s*\\(",
    antiPattern: null,
    filePattern: "**/*.cs",
    exclude: ["**/*.Tests.*", "**/*Test.cs", "**/*Tests.cs", "**/obj/**", "**/bin/**"],
    suggestion:
      "Replace Thread.Sleep(ms) with `await Task.Delay(ms)` in async methods to avoid blocking thread pool threads.",
    fixable: true,
  },
  {
    id: "new-thread-cs",
    severity: "low",
    category: "deprecated-patterns",
    description: "new Thread() used instead of Task.Run — manual threads bypass the thread pool",
    language: "csharp",
    pattern: "new\\s+Thread\\s*\\(",
    antiPattern: null,
    filePattern: "**/*.cs",
    exclude: ["**/*.Tests.*", "**/*Test.cs", "**/*Tests.cs", "**/obj/**", "**/bin/**"],
    suggestion:
      "Use Task.Run(() => DoWork()) or async/await instead of manual Thread creation. The thread pool is more efficient for most workloads.",
    fixable: false,
  },
  {
    id: "missing-using-disposal-cs",
    severity: "high",
    category: "resource-leaks",
    description:
      "IDisposable resource created without a using statement — may not be disposed on exception",
    language: "csharp",
    pattern:
      "(?:new\\s+(?:FileStream|StreamReader|StreamWriter|SqlConnection|SqlCommand|HttpClient|MemoryStream|BinaryReader|BinaryWriter|DbContext|TcpClient|UdpClient|Process|Timer|CancellationTokenSource|Socket|NpgsqlConnection|MySqlConnection)\\s*\\()",
    antiPattern: "using\\s+(?:var|\\w+)",
    filePattern: "**/*.cs",
    exclude: ["**/*.Tests.*", "**/*Test.cs", "**/*Tests.cs", "**/obj/**", "**/bin/**"],
    suggestion:
      "Wrap IDisposable resources in a `using` statement: `using var stream = new FileStream(...)` or `using (var stream = new FileStream(...)) { ... }`.",
    fixable: false,
  },
];

export default rules;
