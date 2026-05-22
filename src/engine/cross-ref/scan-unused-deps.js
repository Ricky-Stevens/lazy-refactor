import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { collectFiles } from "../files.js";

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

  // Build combined source content for grep-style presence checks.
  const contents = [];
  for (const file of files) {
    try {
      contents.push(await readFile(file, "utf8"));
    } catch {
      // skip unreadable
    }
  }
  const combined = contents.join("\n");

  const findings = [];
  for (const dep of manifest.deps) {
    // Word-boundary check avoids false-negatives where a dep name (e.g. "lodash")
    // appears as a substring of an unrelated identifier (e.g. "lodash-es").
    const escaped = dep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`\\b${escaped}\\b`).test(combined)) {
      findings.push({ check: "unused-dep", dep, manifest: manifest.type });
    }
  }

  return findings;
}
