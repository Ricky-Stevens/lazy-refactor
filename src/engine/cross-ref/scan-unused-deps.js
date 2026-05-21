import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { collectFiles } from "../files.js";

/**
 * Detect and parse the package manifest file in a directory.
 * Returns { type, deps } where deps is an array of dependency names.
 * @param {string} dir
 * @returns {Promise<{type: string, deps: string[]}|null>}
 */
export async function detectManifest(dir) {
  // Aggregate across every manifest we can find — polyglot repos (e.g. a Go
  // backend alongside a Node.js frontend) need all dependencies considered,
  // not just whichever file we happened to try first.
  let type = null;
  const deps = [];

  // package.json
  try {
    const pkgJson = await readFile(join(dir, "package.json"), "utf8");
    const pkg = JSON.parse(pkgJson);
    type = type ?? "npm";
    deps.push(
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    );
  } catch {
    // not found or parse error
  }

  // go.mod
  try {
    const goMod = await readFile(join(dir, "go.mod"), "utf8");
    type = type ?? "go";
    for (const line of goMod.split("\n")) {
      const m = line.trim().match(/^([a-zA-Z][^\s]+)\s+v[\d.]/);
      if (m) deps.push(m[1].split("/").pop());
    }
  } catch {
    // not found
  }

  // requirements.txt
  try {
    const req = await readFile(join(dir, "requirements.txt"), "utf8");
    type = type ?? "python";
    deps.push(
      ...req
        .split("\n")
        .map((l) =>
          l
            .trim()
            .split(/[>=<!]/)[0]
            .trim(),
        )
        .filter(Boolean),
    );
  } catch {
    // not found
  }

  // *.csproj — basic heuristic
  try {
    const entries = await readdir(dir);
    const csproj = entries.find((e) => e.endsWith(".csproj"));
    if (csproj) {
      const xml = await readFile(join(dir, csproj), "utf8");
      type = type ?? "csharp";
      for (const m of xml.matchAll(/<PackageReference\s+Include="([^"]+)"/g)) {
        deps.push(m[1]);
      }
    }
  } catch {
    // not found
  }

  // pom.xml
  try {
    const pom = await readFile(join(dir, "pom.xml"), "utf8");
    type = type ?? "java";
    for (const m of pom.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)) {
      deps.push(m[1]);
    }
  } catch {
    // not found
  }

  if (deps.length === 0 && type === null) return null;
  return { type: type ?? "unknown", deps };
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

  // Build combined content from all source files for grep-style check
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
    // appears as a substring of an unrelated identifier (e.g. "lodash-es" in
    // another dep's metadata, or "fooexpress" in source).
    const escaped = dep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`\\b${escaped}\\b`).test(combined)) {
      findings.push({
        check: "unused-dep",
        dep,
        manifest: manifest.type,
      });
    }
  }

  return findings;
}
