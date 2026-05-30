import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { collectFiles, readFilesBatched } from "../files.js";

// --- Per-manifest parsers ---
// Each returns an array of dependency names, or null if the manifest is absent.

async function readNpmDeps(dir) {
  try {
    const pkgJson = await readFile(join(dir, "package.json"), "utf8");
    const pkg = JSON.parse(pkgJson);
    return [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ];
  } catch {
    return null;
  }
}

async function readGoDeps(dir) {
  try {
    const goMod = await readFile(join(dir, "go.mod"), "utf8");
    const deps = [];
    for (const line of goMod.split("\n")) {
      const m = line.trim().match(/^([a-zA-Z][^\s]+)\s+v[\d.]/);
      if (m) deps.push(m[1].split("/").pop());
    }
    return deps;
  } catch {
    return null;
  }
}

async function readPythonDeps(dir) {
  try {
    const req = await readFile(join(dir, "requirements.txt"), "utf8");
    return req
      .split("\n")
      .map((l) =>
        l
          .trim()
          .split(/[>=<!]/)[0]
          .trim(),
      )
      .filter(Boolean);
  } catch {
    return null;
  }
}

async function readCsharpDeps(dir) {
  try {
    const entries = await readdir(dir);
    const csproj = entries.find((e) => e.endsWith(".csproj"));
    if (!csproj) return null;
    const xml = await readFile(join(dir, csproj), "utf8");
    return [...xml.matchAll(/<PackageReference\s+Include="([^"]+)"/g)].map((m) => m[1]);
  } catch {
    return null;
  }
}

async function readJavaDeps(dir) {
  try {
    const pom = await readFile(join(dir, "pom.xml"), "utf8");
    return [...pom.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)].map((m) => m[1]);
  } catch {
    return null;
  }
}

/**
 * Detect and parse all package manifests in a directory.
 * Returns { type, deps } where deps is an aggregated array of dependency names.
 * Aggregates across every manifest found so polyglot repos are fully covered.
 * @param {string} dir
 * @returns {Promise<{type: string, deps: string[]}|null>}
 */
async function detectManifest(dir) {
  const [npm, go, python, csharp, java] = await Promise.all([
    readNpmDeps(dir),
    readGoDeps(dir),
    readPythonDeps(dir),
    readCsharpDeps(dir),
    readJavaDeps(dir),
  ]);

  const deps = [
    ...(npm ?? []),
    ...(go ?? []),
    ...(python ?? []),
    ...(csharp ?? []),
    ...(java ?? []),
  ];

  if (deps.length === 0) return null;

  // Use the first detected ecosystem as the manifest type label.
  const type =
    npm != null
      ? "npm"
      : go != null
        ? "go"
        : python != null
          ? "python"
          : csharp != null
            ? "csharp"
            : java != null
              ? "java"
              : "unknown";

  return { type, deps };
}

// Root config files that reference packages by name (plugins, presets, shared
// configs, CLI tools) without importing them in source. Without these, every
// config/CLI-only dev dependency — typescript, tailwindcss, biome, playwright,
// @types/*, eslint plugins — reads as a false "unused-dep".
const CONFIG_FILE_RE =
  /^(?:.*\.config\.(?:[cm]?[jt]s|json)|biome\.jsonc?|tsconfig.*\.json|\.eslintrc.*|\.prettierrc.*|\.babelrc.*)$/;

/**
 * Build a corpus of non-source signals that reference dependencies by name:
 * root config-file contents plus package.json `scripts`. The package.json
 * dependency blocks are deliberately NOT included — they declare the very names
 * we're testing, so including them would make every dep look used.
 * @param {string} dir
 * @returns {Promise<string>}
 */
async function readConfigCorpus(dir) {
  const parts = [];

  try {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    // scripts reference CLI bins by bare name (e.g. "biome check", "tsc -b").
    if (pkg.scripts) parts.push(Object.values(pkg.scripts).join("\n"));
  } catch {
    // No / unparseable package.json — nothing to contribute from scripts.
  }

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return parts.join("\n");
  }

  for (const entry of entries) {
    if (!entry.isFile() || !CONFIG_FILE_RE.test(entry.name)) continue;
    try {
      parts.push(await readFile(join(dir, entry.name), "utf8"));
    } catch {
      // Unreadable config file — skip; its absence just means fewer use signals.
    }
  }

  return parts.join("\n");
}

/**
 * Expand a dependency into the token(s) whose presence in the corpus proves use.
 * @types/* packages never appear by their own name; they're used via the runtime
 * package they describe (@types/node -> node, @types/babel__core -> @babel/core).
 * @param {string} dep
 * @returns {string[]}
 */
function depUsageTokens(dep) {
  if (!dep.startsWith("@types/")) return [dep];
  const stem = dep.slice("@types/".length);
  // DefinitelyTyped encodes scoped packages as `scope__name` -> `@scope/name`.
  return [dep, stem.includes("__") ? `@${stem.replace("__", "/")}` : stem];
}

/**
 * Resolve the CLI binary names a dependency installs, from its installed
 * package.json `bin` field. A dev tool is "used" when its bin name appears in a
 * script even though the package name never does (typescript -> tsc,
 * @biomejs/biome -> biome). Returns [] when node_modules isn't present or the
 * manifest isn't npm — keeping this safe for non-JS ecosystems.
 * @param {string} root
 * @param {string} dep
 * @returns {Promise<string[]>}
 */
async function readBinNames(root, dep) {
  try {
    const pkg = JSON.parse(await readFile(join(root, "node_modules", dep, "package.json"), "utf8"));
    // npm convention: a string `bin` installs a binary named after the package.
    if (typeof pkg.bin === "string") return [dep.split("/").pop()];
    if (pkg.bin && typeof pkg.bin === "object") return Object.keys(pkg.bin);
    return [];
  } catch {
    return [];
  }
}

/**
 * Whole-word presence test that also works for scoped package names. A leading
 * `\b` is only emitted when the token starts with a word char — without this,
 * `\b@scope/...` never matches (both the quote before and the `@` are non-word
 * chars, so there is no boundary), which is why every @scope/* dep used to be
 * reported as unused.
 * @param {string} token
 * @param {string} corpus
 * @returns {boolean}
 */
function isTokenReferenced(token, corpus) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const left = /^\w/.test(token) ? "\\b" : "";
  const right = /\w$/.test(token) ? "\\b" : "";
  return new RegExp(`${left}${escaped}${right}`).test(corpus);
}

/**
 * Scan for unused dependencies declared in the package manifest.
 * @param {string} path - Directory to scan
 * @param {object} [options]
 * @param {string[]} [options.exclude]
 * @returns {Promise<Array<{check: string, dep: string, manifest: string}>>}
 */
export async function scanUnusedDeps(path, options = {}) {
  const manifest = await detectManifest(path);
  if (!manifest) return [];

  const files = await collectFiles(path, options);
  const contentMap = await readFilesBatched(files);
  const combined = [...contentMap.values(), await readConfigCorpus(path)].join("\n");

  const findings = [];
  for (const dep of manifest.deps) {
    if (depUsageTokens(dep).some((token) => isTokenReferenced(token, combined))) continue;
    // Not referenced by name — it may still be a CLI tool invoked by its bin name
    // in a package.json script (the corpus includes scripts). Resolve bins lazily,
    // only for deps that already failed the cheaper string check.
    const bins = await readBinNames(path, dep);
    if (bins.some((bin) => isTokenReferenced(bin, combined))) continue;
    findings.push({ check: "unused-dep", dep, manifest: manifest.type });
  }

  return findings;
}
