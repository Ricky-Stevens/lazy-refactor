import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import outdatedPatterns from "../rules/outdated-patterns.js";
import { tryRead } from "./detect.js";
import { collectFiles } from "./files.js";

/**
 * Read the project's package manifest(s) and check for outdated dependencies.
 * Supports package.json (JS/TS), go.mod (Go), and requirements.txt (Python).
 * @param {string} projectPath  Directory containing the manifest
 * @param {string[]} languages  Detected language list
 * @returns {Promise<Array>}    Findings with check: 'outdated-pattern'
 */
export async function checkOutdatedDeps(projectPath, languages) {
  const findings = [];

  // JS/TS: scan package.json dependency names AND source files for syntactic patterns
  if (languages.includes("typescript")) {
    const entries = outdatedPatterns.javascript ?? [];
    const pkgJson = await tryRead(projectPath, "package.json");

    // Check package.json deps by name
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
        // Match by package name (the 'from' field may include extra description text)
        const depName = entry.from.split(" ")[0];
        if (allDeps[depName] !== undefined) {
          findings.push({
            check: "outdated-pattern",
            severity: entry.severity,
            category: "outdated",
            locations: [{ file: "package.json", startLine: 1 }],
            description: `Outdated dependency '${entry.from}': ${entry.description}`,
            from: entry.from,
            to: entry.to,
            suggestion: `Migrate from '${entry.from}' to '${entry.to}'.`,
            fixable: true,
            confidence: 0.9,
          });
        }
      }
    }

    // Also scan source files for detectPattern matches (e.g. `var` declarations,
    // callback-style async) — these aren't tied to a package.json dep.
    const jsFiles = await collectFiles(projectPath, { languages: ["typescript"] });
    const jsSources = [];
    for (const f of jsFiles) {
      try {
        jsSources.push(await readFile(f, "utf8"));
      } catch {
        /* skip */
      }
    }
    const combinedJsSource = jsSources.join("\n");

    for (const entry of entries) {
      // Skip entries already reported via package.json
      if (findings.some((f) => f.from === entry.from)) continue;
      if (!entry.detectPattern) continue;

      let pattern;
      try {
        pattern = new RegExp(entry.detectPattern);
      } catch {
        continue;
      }
      if (pattern.test(combinedJsSource)) {
        findings.push({
          check: "outdated-pattern",
          severity: entry.severity,
          category: "outdated",
          locations: [{ file: "source", startLine: 1 }],
          description: `Outdated usage '${entry.from}': ${entry.description}`,
          from: entry.from,
          to: entry.to,
          suggestion: `Migrate from '${entry.from}' to '${entry.to}'.`,
          fixable: true,
          confidence: 0.7,
        });
      }
    }
  }

  // Go: scan *.go source files for each entry's detectPattern before emitting
  if (languages.includes("go")) {
    const entries = outdatedPatterns.go ?? [];
    const goMod = await tryRead(projectPath, "go.mod");
    if (goMod !== null && entries.length > 0) {
      const goFiles = await collectFiles(projectPath, { languages: ["go"] });
      const goSources = await Promise.all(goFiles.map((f) => readFile(f, "utf8").catch(() => "")));
      const combinedSource = goSources.join("\n");

      for (const entry of entries) {
        const pattern = new RegExp(entry.detectPattern);
        if (!pattern.test(combinedSource)) continue;

        findings.push({
          check: "outdated-pattern",
          severity: entry.severity,
          category: "outdated",
          locations: [{ file: "go.mod", startLine: 1 }],
          description: `Outdated usage '${entry.from}': ${entry.description}`,
          from: entry.from,
          to: entry.to,
          suggestion: `Migrate from '${entry.from}' to '${entry.to}'.`,
          fixable: true,
          confidence: 0.7,
        });
      }
    }
  }

  // C#: scan *.csproj for PackageReference entries, and grep source for stdlib patterns
  if (languages.includes("csharp")) {
    const entries = outdatedPatterns.csharp ?? [];
    if (entries.length > 0) {
      // Collect .csproj file contents
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

      const csFiles = await collectFiles(projectPath, { languages: ["csharp"] });
      const csSources = await Promise.all(csFiles.map((f) => readFile(f, "utf8").catch(() => "")));
      const combinedCsSource = csSources.join("\n");

      for (const entry of entries) {
        // Check manifest first (PackageReference Include="X")
        const manifestPattern = new RegExp(
          `PackageReference\\s+Include\\s*=\\s*["']${entry.from.split(" ")[0]}["']`,
          "i",
        );
        const sourcePattern = new RegExp(entry.detectPattern);
        if (manifestPattern.test(csprojContent) || sourcePattern.test(combinedCsSource)) {
          findings.push({
            check: "outdated-pattern",
            severity: entry.severity,
            category: "outdated",
            locations: [{ file: "project", startLine: 1 }],
            description: `Outdated usage '${entry.from}': ${entry.description}`,
            from: entry.from,
            to: entry.to,
            suggestion: `Migrate from '${entry.from}' to '${entry.to}'.`,
            fixable: true,
            confidence: 0.8,
          });
        }
      }
    }
  }

  // Java: scan pom.xml/build.gradle for dependency entries, and grep source for stdlib patterns
  if (languages.includes("java")) {
    const entries = outdatedPatterns.java ?? [];
    if (entries.length > 0) {
      let manifestContent = "";
      try {
        const pom = await readFile(join(projectPath, "pom.xml"), "utf8");
        manifestContent += pom;
      } catch {
        /* no pom.xml */
      }
      try {
        const gradle = await readFile(join(projectPath, "build.gradle"), "utf8");
        manifestContent += gradle;
      } catch {
        /* no build.gradle */
      }

      const javaFiles = await collectFiles(projectPath, { languages: ["java"] });
      const javaSources = await Promise.all(
        javaFiles.map((f) => readFile(f, "utf8").catch(() => "")),
      );
      const combinedJavaSource = javaSources.join("\n");

      for (const entry of entries) {
        // Check manifest (pom.xml <artifactId>X</artifactId> or build.gradle implementation 'group:artifact')
        const artifactName = entry.from.split(".").pop().split(" ")[0];
        const pomPattern = new RegExp(`<artifactId>\\s*${artifactName}\\s*</artifactId>`, "i");
        const gradlePattern = new RegExp(
          `implementation\\s+['"][^'"]*:${artifactName}[^'"]*['"]`,
          "i",
        );
        const sourcePattern = new RegExp(entry.detectPattern);

        if (
          pomPattern.test(manifestContent) ||
          gradlePattern.test(manifestContent) ||
          sourcePattern.test(combinedJavaSource)
        ) {
          findings.push({
            check: "outdated-pattern",
            severity: entry.severity,
            category: "outdated",
            locations: [{ file: "project", startLine: 1 }],
            description: `Outdated usage '${entry.from}': ${entry.description}`,
            from: entry.from,
            to: entry.to,
            suggestion: `Migrate from '${entry.from}' to '${entry.to}'.`,
            fixable: true,
            confidence: 0.75,
          });
        }
      }
    }
  }

  // Python: scan requirements.txt for deprecated packages AND .py source files for detectPattern
  if (languages.includes("python")) {
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
          findings.push({
            check: "outdated-pattern",
            severity: entry.severity,
            category: "outdated",
            locations: [{ file: "requirements.txt", startLine: 1 }],
            description: `Outdated dependency '${entry.from}': ${entry.description}`,
            from: entry.from,
            to: entry.to,
            suggestion: `Migrate from '${entry.from}' to '${entry.to}'.`,
            fixable: true,
            confidence: 0.9,
          });
        }
      }
    }

    // Also scan .py source files for detectPattern matches (stdlib modules like
    // urllib2, optparse etc. are not pip packages — they appear in source imports).
    const pyFiles = await collectFiles(projectPath, { languages: ["python"] });
    const pySources = await Promise.all(pyFiles.map((f) => readFile(f, "utf8").catch(() => "")));
    const combinedPySource = pySources.join("\n");

    for (const entry of entries) {
      if (reportedFroms.has(entry.from)) continue;
      if (!entry.detectPattern) continue;

      let pattern;
      try {
        pattern = new RegExp(entry.detectPattern);
      } catch {
        continue;
      }
      if (pattern.test(combinedPySource)) {
        findings.push({
          check: "outdated-pattern",
          severity: entry.severity,
          category: "outdated",
          locations: [{ file: "source", startLine: 1 }],
          description: `Outdated usage '${entry.from}': ${entry.description}`,
          from: entry.from,
          to: entry.to,
          suggestion: `Migrate from '${entry.from}' to '${entry.to}'.`,
          fixable: true,
          confidence: 0.7,
        });
      }
    }
  }

  return findings;
}
