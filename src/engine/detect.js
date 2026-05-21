import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Try to read a file relative to a base directory. Returns content or null.
 * @param {string} baseDir
 * @param {string} file
 * @returns {Promise<string|null>}
 */
export async function tryRead(baseDir, file) {
  try {
    return await readFile(join(baseDir, file), "utf8");
  } catch {
    return null;
  }
}

/**
 * Detect languages in use at a project path by inspecting marker files.
 * @param {string} projectPath
 * @returns {Promise<{languages: string[], markers: object}>}
 */
export async function detectLanguages(projectPath) {
  const markers = {};
  const languages = [];

  // Helper: look for files matching a suffix in the project root
  async function findBySuffix(suffix) {
    try {
      const entries = await readdir(projectPath);
      return entries.filter((e) => e.endsWith(suffix));
    } catch {
      return [];
    }
  }

  // TypeScript / JavaScript: package.json with typescript dep, or tsconfig
  const pkgJson = await tryRead(projectPath, "package.json");
  if (pkgJson !== null) {
    markers["package.json"] = true;
    try {
      const pkg = JSON.parse(pkgJson);
      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.peerDependencies,
      };
      if (allDeps.typescript || allDeps["ts-node"] || allDeps.tsx) {
        languages.push("typescript");
        markers.typescript = true;
      } else {
        // Plain JavaScript project
        languages.push("typescript"); // treat JS projects with package.json the same
        markers.javascript = true;
      }
    } catch {
      languages.push("typescript");
    }
  }

  const tsConfig = await tryRead(projectPath, "tsconfig.json");
  if (tsConfig !== null && !languages.includes("typescript")) {
    languages.push("typescript");
    markers["tsconfig.json"] = true;
  }

  // Go: go.mod
  const goMod = await tryRead(projectPath, "go.mod");
  if (goMod !== null) {
    languages.push("go");
    markers["go.mod"] = true;
  }

  // Python: requirements.txt or pyproject.toml
  const requirements = await tryRead(projectPath, "requirements.txt");
  if (requirements !== null) {
    if (!languages.includes("python")) languages.push("python");
    markers["requirements.txt"] = true;
  }
  const pyproject = await tryRead(projectPath, "pyproject.toml");
  if (pyproject !== null) {
    if (!languages.includes("python")) languages.push("python");
    markers["pyproject.toml"] = true;
  }
  const setupPy = await tryRead(projectPath, "setup.py");
  if (setupPy !== null) {
    if (!languages.includes("python")) languages.push("python");
    markers["setup.py"] = true;
  }

  // C#: *.csproj or *.sln
  const csprojFiles = await findBySuffix(".csproj");
  const slnFiles = await findBySuffix(".sln");
  if (csprojFiles.length > 0 || slnFiles.length > 0) {
    languages.push("csharp");
    if (csprojFiles.length > 0) markers[csprojFiles[0]] = true;
    if (slnFiles.length > 0) markers[slnFiles[0]] = true;
  }

  // Java: pom.xml or build.gradle
  const pomXml = await tryRead(projectPath, "pom.xml");
  if (pomXml !== null) {
    languages.push("java");
    markers["pom.xml"] = true;
  }
  const buildGradle = await tryRead(projectPath, "build.gradle");
  if (buildGradle !== null) {
    if (!languages.includes("java")) languages.push("java");
    markers["build.gradle"] = true;
  }

  // Check immediate subdirectories (one level deep) for marker files
  try {
    const entries = await readdir(projectPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const subdir = join(projectPath, entry.name);

      // TypeScript / JavaScript: package.json in subdir
      const subPkg = await tryRead(projectPath, join(entry.name, "package.json"));
      if (subPkg !== null && !languages.includes("typescript")) {
        languages.push("typescript");
        markers[`${entry.name}/package.json`] = true;
      }

      // Go: go.mod in subdir
      const subGoMod = await tryRead(projectPath, join(entry.name, "go.mod"));
      if (subGoMod !== null && !languages.includes("go")) {
        languages.push("go");
        markers[`${entry.name}/go.mod`] = true;
      }

      // Python: requirements.txt in subdir
      const subReq = await tryRead(projectPath, join(entry.name, "requirements.txt"));
      if (subReq !== null && !languages.includes("python")) {
        languages.push("python");
        markers[`${entry.name}/requirements.txt`] = true;
      }

      // Python: pyproject.toml in subdir
      const subPyproject = await tryRead(projectPath, join(entry.name, "pyproject.toml"));
      if (subPyproject !== null && !languages.includes("python")) {
        languages.push("python");
        markers[`${entry.name}/pyproject.toml`] = true;
      }

      // Java: pom.xml in subdir
      const subPom = await tryRead(projectPath, join(entry.name, "pom.xml"));
      if (subPom !== null && !languages.includes("java")) {
        languages.push("java");
        markers[`${entry.name}/pom.xml`] = true;
      }

      // Java: build.gradle in subdir
      const subGradle = await tryRead(projectPath, join(entry.name, "build.gradle"));
      if (subGradle !== null && !languages.includes("java")) {
        languages.push("java");
        markers[`${entry.name}/build.gradle`] = true;
      }

      // C#: *.csproj in subdir
      try {
        const subEntries = await readdir(subdir);
        const subCsproj = subEntries.filter((e) => e.endsWith(".csproj"));
        const subSln = subEntries.filter((e) => e.endsWith(".sln"));
        if ((subCsproj.length > 0 || subSln.length > 0) && !languages.includes("csharp")) {
          languages.push("csharp");
          if (subCsproj.length > 0) markers[`${entry.name}/${subCsproj[0]}`] = true;
          if (subSln.length > 0) markers[`${entry.name}/${subSln[0]}`] = true;
        }
      } catch {
        // skip unreadable subdirs
      }
    }
  } catch {
    // skip if root readdir fails (already handled above for root-level detection)
  }

  return { languages, markers };
}
