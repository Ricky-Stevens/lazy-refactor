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
    id: "magic-number",
    severity: "low",
    category: "hardcoded-magic-values",
    description: "Large numeric literals (≥100) used directly in logic instead of named constants",
    language: "common",
    pattern: "(?<![a-zA-Z0-9_.])\\b[1-9]\\d{2,}\\b",
    antiPattern:
      "(?:status|STATUS|port|PORT|timeout|TIMEOUT|\\bHTTP|\\bversion|epoch|batch|learning.?rate|threshold|seed|SEED)",
    filePattern: "**/*.{ts,tsx,js,jsx,go,py,cs,java}",
    exclude: [
      "**/*.test.*",
      "**/*.spec.*",
      "**/*_test.go",
      "**/*.min.js",
      "**/vendor/**",
      "**/node_modules/**",
      "**/*.config.*",
      "**/*.json",
    ],
    suggestion:
      "Extract large numeric literals into named constants (e.g. const MAX_BUFFER_SIZE = 4096) to improve readability and maintainability.",
    fixable: false,
  },
  {
    id: "ai-step-comment",
    severity: "low",
    category: "comment-quality",
    description:
      'AI-generated step comments like "Step 1:", "// 1.", "# Step X:" that narrate code instead of explaining intent',
    language: "common",
    pattern: "(?:^|\\s)(?://|#|/\\*)\\s*(?:[Ss]tep\\s+\\d+|\\d+\\.\\s+\\w)",
    antiPattern: null,
    filePattern: "**/*.{ts,tsx,js,jsx,go,py,cs,java}",
    exclude: ["**/node_modules/**", "**/vendor/**"],
    suggestion:
      "Replace procedural step comments with explanatory comments that describe WHY, not WHAT. Consider restructuring with well-named functions instead.",
    fixable: false,
  },
  {
    id: "hardcoded-url",
    severity: "medium",
    category: "hardcoded-values",
    description:
      "Hardcoded URL in source code — should be moved to configuration or environment variables",
    language: "common",
    pattern:
      "https?://(?!localhost|127\\.0\\.0\\.1|example\\.com|schema\\.org|www\\.w3\\.org|tools\\.ietf\\.org)[^\\s\"'`]+",
    antiPattern: null,
    filePattern: "**/*.{ts,tsx,js,jsx,go,py,cs,java}",
    exclude: [
      "**/*.test.*",
      "**/*.spec.*",
      "**/*_test.go",
      "**/__tests__/**",
      "**/*.stories.*",
      "**/*.json",
      "**/*.yaml",
      "**/*.yml",
      "**/*.toml",
      "**/*.env*",
      "**/*.config.*",
      "**/*.md",
      "**/node_modules/**",
      "**/vendor/**",
    ],
    suggestion:
      "Move hardcoded URLs to environment variables or configuration files so they can be changed per environment without code changes.",
    fixable: false,
  },
  {
    id: "hardcoded-filepath",
    severity: "low",
    category: "hardcoded-values",
    description:
      "Hardcoded absolute file path — will not work across environments or operating systems",
    language: "common",
    pattern: "(?:/usr/|/home/|/var/|/tmp/|/etc/|[A-Z]:\\\\\\\\)",
    antiPattern: null,
    filePattern: "**/*.{ts,tsx,js,jsx,go,py,cs,java}",
    exclude: ["**/node_modules/**", "**/vendor/**"],
    suggestion:
      "Replace hardcoded paths with environment variables, configuration values, or path-building utilities so the code works across environments.",
    fixable: false,
  },
  {
    id: "hardcoded-secret",
    severity: "critical",
    category: "security",
    description: "Possible hardcoded secret, API key, or token in source code",
    language: "common",
    pattern:
      "(?:[Aa][Pp][Ii][_-]?[Kk][Ee][Yy]|[Aa][Pp][Ii][_-]?[Ss][Ee][Cc][Rr][Ee][Tt]|[Aa][Uu][Tt][Hh][_-]?[Tt][Oo][Kk][Ee][Nn]|[Aa][Cc][Cc][Ee][Ss][Ss][_-]?[Tt][Oo][Kk][Ee][Nn]|[Ss][Ee][Cc][Rr][Ee][Tt][_-]?[Kk][Ee][Yy]|[Pp][Rr][Ii][Vv][Aa][Tt][Ee][_-]?[Kk][Ee][Yy]|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Pp][Aa][Ss][Ss][Ww][Dd])\\s*(?:=|:)\\s*[\"'`][A-Za-z0-9+/=_-]{8,}[\"'`]",
    antiPattern: "example|placeholder|your[_-]|xxx|test|dummy|fake|mock|TODO|CHANGEME",
    filePattern: "**/*.{ts,tsx,js,jsx,go,py,cs,java}",
    exclude: [
      "**/*.test.*",
      "**/*.spec.*",
      "**/*_test.go",
      "**/node_modules/**",
      "**/vendor/**",
      "**/.env.example",
    ],
    suggestion:
      "Move secrets to environment variables or a secrets manager. Never commit credentials to source control.",
    fixable: false,
  },
];

export default rules;
