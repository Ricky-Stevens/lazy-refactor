/**
 * Outdated pattern migration map, keyed by ecosystem.
 * Each entry describes a migration path the scanner can detect and suggest.
 *
 * @type {Record<string, Array<{
 *   from: string,
 *   to: string,
 *   description: string,
 *   detectPattern: string,
 *   severity: string
 * }>>}
 */
const outdatedPatterns = {
  javascript: [
    {
      from: 'moment',
      to: 'dayjs',
      description: 'moment.js is deprecated and adds ~300 KB to bundles. dayjs is API-compatible at ~2 KB.',
      detectPattern: 'import\\s+moment\\s+from\\s+[\'"]moment[\'"]|require\\s*\\([\'"]moment[\'"]\\)',
      severity: 'medium',
    },
    {
      from: 'request',
      to: 'got',
      description: 'request is deprecated (archived 2020). Use got, node-fetch, or the native fetch API.',
      detectPattern: 'require\\s*\\([\'"]request[\'"]\\)|import\\s+request\\s+from\\s+[\'"]request[\'"]',
      severity: 'high',
    },
    {
      from: 'lodash (full import)',
      to: 'lodash-es or named imports',
      description: 'Importing the full lodash bundle prevents tree-shaking. Use named imports or lodash-es.',
      detectPattern: 'import\\s+(?:_|lodash)\\s+from\\s+[\'"]lodash[\'"]|require\\s*\\([\'"]lodash[\'"]\\)',
      severity: 'medium',
    },
    {
      from: 'var declarations',
      to: 'const / let',
      description: '`var` has function scope and hoisting behaviour that causes subtle bugs. Use `const` or `let`.',
      detectPattern: '\\bvar\\s+\\w',
      severity: 'low',
    },
    {
      from: 'callback-style async',
      to: 'async/await',
      description: 'Node-style callbacks (err, result) are error-prone and hard to read. Migrate to async/await.',
      detectPattern: 'function\\s*\\([^)]*(?:err|error|cb|callback)[^)]*\\)\\s*\\{',
      severity: 'low',
    },
    {
      from: 'underscore',
      to: 'native array methods or lodash-es',
      description: 'underscore.js is superseded by native Array/Object methods and modern utilities.',
      detectPattern: 'import\\s+_\\s+from\\s+[\'"]underscore[\'"]|require\\s*\\([\'"]underscore[\'"]\\)',
      severity: 'low',
    },
  ],
  python: [
    {
      from: 'urllib2',
      to: 'requests or httpx',
      description: 'urllib2 does not exist in Python 3. Use the requests library or httpx for modern HTTP.',
      detectPattern: 'import\\s+urllib2|from\\s+urllib2\\s+import',
      severity: 'critical',
    },
    {
      from: 'optparse',
      to: 'argparse',
      description: 'optparse is deprecated since Python 3.2. Use argparse or click for CLI argument parsing.',
      detectPattern: 'import\\s+optparse|from\\s+optparse\\s+import',
      severity: 'medium',
    },
    {
      from: 'os.path',
      to: 'pathlib.Path',
      description: 'os.path is procedural and verbose. pathlib provides an object-oriented, composable API.',
      detectPattern: 'os\\.path\\.(?:join|exists|dirname|basename|splitext|abspath|isfile|isdir)\\s*\\(',
      severity: 'low',
    },
    {
      from: 'percent string formatting (%)',
      to: 'f-strings',
      description: 'Old-style % formatting is error-prone. f-strings are faster, clearer, and less error-prone.',
      detectPattern: '"[^"]*%[sdifr][^"]*"\\s*%\\s*\\(',
      severity: 'low',
    },
    {
      from: '.format() string formatting',
      to: 'f-strings',
      description: '.format() is more verbose than f-strings. Migrate to f-strings for Python 3.6+ code.',
      detectPattern: '"[^"]*\\{[^}]*\\}[^"]*"\\.format\\s*\\(',
      severity: 'low',
    },
  ],
  go: [
    {
      from: 'ioutil.ReadFile',
      to: 'os.ReadFile',
      description: 'ioutil is deprecated since Go 1.16. Use os.ReadFile directly.',
      detectPattern: 'ioutil\\.ReadFile\\s*\\(',
      severity: 'medium',
    },
    {
      from: 'ioutil.WriteFile',
      to: 'os.WriteFile',
      description: 'ioutil is deprecated since Go 1.16. Use os.WriteFile directly.',
      detectPattern: 'ioutil\\.WriteFile\\s*\\(',
      severity: 'medium',
    },
    {
      from: 'ioutil.ReadAll',
      to: 'io.ReadAll',
      description: 'ioutil is deprecated since Go 1.16. Use io.ReadAll directly.',
      detectPattern: 'ioutil\\.ReadAll\\s*\\(',
      severity: 'medium',
    },
    {
      from: 'ioutil.TempDir',
      to: 'os.MkdirTemp',
      description: 'ioutil is deprecated since Go 1.16. Use os.MkdirTemp directly.',
      detectPattern: 'ioutil\\.TempDir\\s*\\(',
      severity: 'medium',
    },
    {
      from: 'ioutil.TempFile',
      to: 'os.CreateTemp',
      description: 'ioutil is deprecated since Go 1.16. Use os.CreateTemp directly.',
      detectPattern: 'ioutil\\.TempFile\\s*\\(',
      severity: 'medium',
    },
  ],
  csharp: [
    {
      from: 'WebClient',
      to: 'HttpClient (via IHttpClientFactory)',
      description: 'WebClient is deprecated. HttpClient supports async/await, connection pooling, and is the modern .NET HTTP API.',
      detectPattern: 'new\\s+WebClient\\s*\\(',
      severity: 'medium',
    },
    {
      from: 'Thread.Sleep',
      to: 'await Task.Delay',
      description: 'Thread.Sleep blocks a thread pool thread. In async contexts, use await Task.Delay() to yield.',
      detectPattern: 'Thread\\.Sleep\\s*\\(',
      severity: 'medium',
    },
    {
      from: 'IAsyncResult / Begin*/End* pattern',
      to: 'async/await',
      description: 'The APM (Begin/End) pattern is superseded by async/await. Migrate to Task-based async.',
      detectPattern: 'IAsyncResult\\s+\\w+\\s*=|Begin\\w+\\s*\\(',
      severity: 'low',
    },
  ],
  java: [
    {
      from: 'java.util.Date',
      to: 'java.time.Instant / LocalDateTime',
      description: 'java.util.Date is mutable, poorly-designed, and mostly deprecated. Use java.time (JSR-310).',
      detectPattern: 'new\\s+Date\\s*\\(',
      severity: 'medium',
    },
    {
      from: 'Calendar',
      to: 'java.time.LocalDate / LocalDateTime',
      description: 'Calendar is verbose and error-prone. java.time.LocalDate/LocalDateTime are cleaner alternatives.',
      detectPattern: 'Calendar\\.getInstance\\s*\\(',
      severity: 'medium',
    },
    {
      from: 'Vector',
      to: 'ArrayList',
      description: 'Vector is a legacy synchronized collection. Use ArrayList (or CopyOnWriteArrayList for thread safety).',
      detectPattern: '\\bVector\\s*<',
      severity: 'medium',
    },
    {
      from: 'Hashtable',
      to: 'HashMap / ConcurrentHashMap',
      description: 'Hashtable is a legacy synchronized map. Use HashMap or ConcurrentHashMap.',
      detectPattern: '\\bHashtable\\s*<',
      severity: 'medium',
    },
  ],
};

export default outdatedPatterns;
