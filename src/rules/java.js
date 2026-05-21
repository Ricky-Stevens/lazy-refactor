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
    id: "empty-catch-java",
    severity: "high",
    category: "error-handling",
    description: "Empty catch block — exception is silently swallowed",
    language: "java",
    pattern: "catch\\s*\\([^)]+\\)\\s*\\{\\s*\\}",
    antiPattern: null,
    filePattern: "**/*.java",
    exclude: ["**/*Test.java", "**/*Tests.java", "**/test/**", "**/target/**"],
    suggestion:
      "Handle exceptions explicitly: log with a logger and re-throw, or wrap in a domain exception. An empty catch block hides failures silently.",
    fixable: true,
  },
  {
    id: "catch-broad-exception-java",
    severity: "medium",
    category: "error-handling",
    description:
      "Catching Exception or Throwable is too broad — catches unrelated runtime exceptions",
    language: "java",
    pattern: "catch\\s*\\(\\s*(?:Exception|Throwable)\\s+",
    antiPattern: null,
    filePattern: "**/*.java",
    exclude: ["**/*Test.java", "**/*Tests.java", "**/test/**", "**/target/**"],
    suggestion:
      "Catch specific exception types. If a broad catch is needed, re-throw unexpected exceptions: catch (Exception e) { if (e instanceof RuntimeException) throw e; ... }",
    fixable: true,
  },
  {
    id: "raw-type-java",
    severity: "medium",
    category: "type-safety",
    description:
      "Raw collection type used without generic parameter — loses compile-time type checking",
    language: "java",
    pattern: "(?:List|Map|Set|Collection|Queue|Deque)\\s+\\w+\\s*[=;]",
    antiPattern: null,
    filePattern: "**/*.java",
    exclude: ["**/*Test.java", "**/*Tests.java", "**/test/**", "**/target/**"],
    suggestion:
      "Use generic types: List<String> instead of List, Map<String, Integer> instead of Map.",
    fixable: true,
  },
  {
    id: "printstacktrace-java",
    severity: "medium",
    category: "error-handling",
    description: "e.printStackTrace() used instead of structured logging",
    language: "java",
    pattern: "\\.printStackTrace\\s*\\(\\s*\\)",
    antiPattern: null,
    filePattern: "**/*.java",
    exclude: ["**/*Test.java", "**/*Tests.java", "**/test/**", "**/target/**"],
    suggestion:
      'Replace e.printStackTrace() with `logger.error("Operation failed", e)`. Structured loggers preserve stack traces while supporting log levels and appenders.',
    fixable: true,
  },
  {
    id: "system-out-debug-java",
    severity: "medium",
    category: "debugging-leftovers",
    description: "System.out.println / System.err.println used for debug output",
    language: "java",
    pattern: "System\\.(?:out|err)\\.print(?:ln|f)?\\s*\\(",
    antiPattern: null,
    filePattern: "**/*.java",
    exclude: ["**/*Test.java", "**/*Tests.java", "**/test/**", "**/target/**"],
    suggestion:
      "Replace System.out.println with a logger (SLF4J, Log4j2, java.util.logging). Logging frameworks support levels, appenders, and structured output.",
    fixable: true,
  },
  {
    id: "vector-deprecated-java",
    severity: "medium",
    category: "deprecated-patterns",
    description:
      "Vector used instead of ArrayList — Vector is synchronized by default, causing unnecessary overhead",
    language: "java",
    pattern: "\\bVector\\b",
    antiPattern: null,
    filePattern: "**/*.java",
    exclude: ["**/*Test.java", "**/*Tests.java", "**/test/**", "**/target/**"],
    suggestion:
      "Replace Vector with ArrayList. If thread safety is required, use Collections.synchronizedList(new ArrayList<>()) or CopyOnWriteArrayList.",
    fixable: true,
  },
  {
    id: "hashtable-deprecated-java",
    severity: "medium",
    category: "deprecated-patterns",
    description:
      "Hashtable used instead of HashMap — Hashtable is synchronized by default with unnecessary overhead",
    language: "java",
    pattern: "\\bHashtable\\b",
    antiPattern: null,
    filePattern: "**/*.java",
    exclude: ["**/*Test.java", "**/*Tests.java", "**/test/**", "**/target/**"],
    suggestion:
      "Replace Hashtable with HashMap. If thread safety is needed, use ConcurrentHashMap.",
    fixable: true,
  },
  {
    id: "stack-deprecated-java",
    severity: "low",
    category: "deprecated-patterns",
    description:
      "Stack used instead of Deque — Stack extends Vector and inherits its performance issues",
    language: "java",
    pattern: "\\bStack\\s*<",
    antiPattern: null,
    filePattern: "**/*.java",
    exclude: ["**/*Test.java", "**/*Tests.java", "**/test/**", "**/target/**"],
    suggestion:
      "Replace Stack<T> with Deque<T> (ArrayDeque implementation). ArrayDeque is faster and has no synchronisation overhead.",
    fixable: true,
  },
  {
    id: "stringbuffer-deprecated-java",
    severity: "low",
    category: "deprecated-patterns",
    description: "StringBuffer used in single-threaded code instead of StringBuilder",
    language: "java",
    pattern: "\\bStringBuffer\\b",
    antiPattern: null,
    filePattern: "**/*.java",
    exclude: ["**/*Test.java", "**/*Tests.java", "**/test/**", "**/target/**"],
    suggestion:
      "Replace StringBuffer with StringBuilder in single-threaded contexts. StringBuilder is faster because it has no synchronisation overhead.",
    fixable: true,
  },
  {
    id: "date-deprecated-java",
    severity: "medium",
    category: "deprecated-patterns",
    description:
      "java.util.Date or Calendar used instead of java.time API — old date API is error-prone and mutable",
    language: "java",
    pattern: "(?:new\\s+Date\\s*\\(|Calendar\\.getInstance\\s*\\(|new\\s+SimpleDateFormat\\s*\\()",
    antiPattern: null,
    filePattern: "**/*.java",
    exclude: ["**/*Test.java", "**/*Tests.java", "**/test/**", "**/target/**"],
    suggestion:
      "Migrate to java.time: Date→Instant/LocalDateTime, Calendar→LocalDate/LocalDateTime, SimpleDateFormat→DateTimeFormatter. The java.time API is immutable and thread-safe.",
    fixable: true,
  },
  {
    id: "missing-try-with-resources-java",
    severity: "high",
    category: "resource-leaks",
    description:
      "AutoCloseable resource opened without try-with-resources — may not be closed on exception",
    language: "java",
    pattern:
      "(?:new\\s+(?:BufferedReader|BufferedWriter|FileReader|FileWriter|FileInputStream|FileOutputStream|InputStreamReader|OutputStreamWriter|ZipFile|Connection|PreparedStatement|ResultSet)\\s*\\(|\\.getConnection\\s*\\(|\\.prepareStatement\\s*\\(|\\.createStatement\\s*\\(|\\.executeQuery\\s*\\()",
    antiPattern: "try\\s*\\(",
    filePattern: "**/*.java",
    exclude: ["**/*Test.java", "**/*Tests.java", "**/test/**", "**/target/**"],
    suggestion:
      "Use try-with-resources: `try (BufferedReader reader = new BufferedReader(...)) { ... }`. This guarantees the resource is closed even if an exception is thrown.",
    fixable: true,
  },
];

export default rules;
