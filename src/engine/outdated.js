import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import outdatedPatterns from "../rules/outdated-patterns.js";
import { tryRead } from "./detect.js";
import { collectFiles } from "./files.js";

/** Build a standard outdated-pattern finding object. */
function makeFinding(entry, locationFile, confidence) {
  return {
    check: "outdated-pattern",
    severity: entry.severity,
    category: "outdated",
    locations: [{ file: locationFile, startLine: 1 }],
    description: `Outdated ${locationFile === "source" ? "usage" : "dependency"} '${entry.from}': ${entry.description}`,
    from: entry.from,
    to: entry.to,
    suggestion: `Migrate from '${entry.from}' to '${entry.to}'.`,
    fixable: true,
    confidence,
  };
}

/** Collect and concatenate source file contents for a given language. */
async function readSources(projectPath, language) {
  const files = await collectFiles(projectPath, { languages: [language] });
  const sources = await Promise.all(files.map((f) => readFile(f, "utf8").catch(() => "")));
  return sources.join("\n");
}

/** Test an entry's detectPattern against combined source; returns true on match. */
function matchesSource(entry, combinedSource) {
  if (!entry.detectPattern) return false;
  try {
    return new RegExp(entry.detectPattern).test(combinedSource);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Per-language handlers
// ---------------------------------------------------------------------------

async function checkJavaScript(projectPath, findings) {
  const entries = outdatedPatterns.javascript ?? [];
  const pkgJson = await tryRead(projectPath, "package.json");

  if (pkgJson !== null) {
    let pkg;
    try {
      pkg = JSON.parse(pkgJson);
    } catch {
      pkg = {};
    }
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
    };
    for (const entry of entries) {
      const depName = entry.from.split(" ")[0];
      if (allDeps[depName] !== undefined) {
        findings.push(makeFinding(entry, "package.json", 0.9));
      }
    }
  }

  // Scan source files for syntactic patterns not tied to a package.json dep.
  const combinedSource = await readSources(projectPath, "typescript");
  for (const entry of entries) {
    if (findings.some((f) => f.from === entry.from)) continue;
    if (matchesSource(entry, combinedSource)) {
      findings.push(makeFinding(entry, "source", 0.7));
    }
  }
}

async function checkGo(projectPath, findings) {
  const entries = outdatedPatterns.go ?? [];
  const goMod = await tryRead(projectPath, "go.mod");
  if (goMod === null || entries.length === 0) return;

  const combinedSource = await readSources(projectPath, "go");
  for (const entry of entries) {
    if (matchesSource(entry, combinedSource)) {
      findings.push(makeFinding(entry, "go.mod", 0.7));
    }
  }
}

async function checkCSharp(projectPath, findings) {
  const entries = outdatedPatterns.csharp ?? [];
  if (entries.length === 0) return;

  let csprojContent = "";
  try {
    const rootEntries = await readdir(projectPath);
    const csprojFiles = rootEntries.filter((e) => e.endsWith(".csproj"));
    for (const f of csprojFiles) {
      try {
        csprojContent += await readFile(join(projectPath, f), "utf8");
      } catch {
        /* skip */
      }
    }
  } catch {
    /* skip */
  }

  const combinedSource = await readSources(projectPath, "csharp");
  for (const entry of entries) {
    const manifestPattern = new RegExp(
      `PackageReference\\s+Include\\s*=\\s*["']${entry.from.split(" ")[0]}["']`,
      "i",
    );
    if (manifestPattern.test(csprojContent) || matchesSource(entry, combinedSource)) {
      findings.push(makeFinding(entry, "project", 0.8));
    }
  }
}

async function checkJava(projectPath, findings) {
  const entries = outdatedPatterns.java ?? [];
  if (entries.length === 0) return;

  let manifestContent = "";
  try {
    manifestContent += await readFile(join(projectPath, "pom.xml"), "utf8");
  } catch {
    /* no pom.xml */
  }
  try {
    manifestContent += await readFile(join(projectPath, "build.gradle"), "utf8");
  } catch {
    /* no build.gradle */
  }

  const combinedSource = await readSources(projectPath, "java");
  for (const entry of entries) {
    const artifactName = entry.from.split(".").pop().split(" ")[0];
    const pomPattern = new RegExp(`<artifactId>\\s*${artifactName}\\s*</artifactId>`, "i");
    const gradlePattern = new RegExp(
      `implementation\\s+['"][^'"]*:${artifactName}[^'"]*['"]`,
      "i",
    );
    if (
      pomPattern.test(manifestContent) ||
      gradlePattern.test(manifestContent) ||
      matchesSource(entry, combinedSource)
    ) {
      findings.push(makeFinding(entry, "project", 0.75));
    }
  }
}

async function checkPython(projectPath, findings) {
  const entries = outdatedPatterns.python ?? [];
  const requirements = await tryRead(projectPath, "requirements.txt");
  const reportedFroms = new Set();

  if (requirements !== null) {
    const lines = requirements.split("\n").map((l) => l.trim());
    for (const entry of entries) {
      const depName = entry.from.split(" ")[0].toLowerCase();
      const matched = lines.some(
        (line) =>
          line.toLowerCase().startsWith(`${depName}==`) ||
          line.toLowerCase().startsWith(`${depName}>=`) ||
          line.toLowerCase().startsWith(`${depName}>`) ||
          line.toLowerCase() === depName,
      );
      if (matched) {
        reportedFroms.add(entry.from);
        findings.push(makeFinding(entry, "requirements.txt", 0.9));
      }
    }
  }

  // Also scan .py source files for stdlib patterns (urllib2, optparse etc.)
  const combinedSource = await readSources(projectPath, "python");
  for (const entry of entries) {
    if (reportedFroms.has(entry.from)) continue;
    if (matchesSource(entry, combinedSource)) {
      findings.push(makeFinding(entry, "source", 0.7));
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the project's package manifest(s) and check for outdated dependencies.
 * Supports package.json (JS/TS), go.mod (Go), requirements.txt (Python),
 * .csproj (C#), and pom.xml/build.gradle (Java).
 * @param {string} projectPath  Directory containing the manifest
 * @param {string[]} languages  Detected language list
 * @returns {Promise<Array>}    Findings with check: 'outdated-pattern'
 */
export async function checkOutdatedDeps(projectPath, languages) {
  const findings = [];

  if (languages.includes("typescript")) await checkJavaScript(projectPath, findings);
  if (languages.includes("go")) await checkGo(projectPath, findings);
  if (languages.includes("csharp")) await checkCSharp(projectPath, findings);
  if (languages.includes("java")) await checkJava(projectPath, findings);
  if (languages.includes("python")) await checkPython(projectPath, findings);

  return findings;
}
