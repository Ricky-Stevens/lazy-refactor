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
 * List files in a directory matching a suffix. Returns [] on error.
 * @param {string} dir
 * @param {string} suffix
 * @returns {Promise<string[]>}
 */
async function findBySuffix(dir, suffix) {
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => e.endsWith(suffix));
  } catch {
    return [];
  }
}

/**
 * Add a language to the set if not already present.
 * @param {string[]} languages
 * @param {string} lang
 */
function addLanguage(languages, lang) {
  if (!languages.includes(lang)) languages.push(lang);
}

/**
 * Detect languages from root-level marker files.
 * @param {string} projectPath
 * @param {string[]} languages
 * @param {object} markers
 */
async function detectRootMarkers(projectPath, languages, markers) {
  const pkgJson = await tryRead(projectPath, "package.json");
  if (pkgJson !== null) {
    markers["package.json"] = true;
    try {
      const pkg = JSON.parse(pkgJson);
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
      if (allDeps.typescript || allDeps["ts-node"] || allDeps.tsx) {
        markers.typescript = true;
      } else {
        markers.javascript = true;
      }
    } catch {
      // treat unparseable package.json as a JS/TS project
    }
    addLanguage(languages, "typescript");
  }

  const tsConfig = await tryRead(projectPath, "tsconfig.json");
  if (tsConfig !== null && !languages.includes("typescript")) {
    languages.push("typescript");
    markers["tsconfig.json"] = true;
  }

  const goMod = await tryRead(projectPath, "go.mod");
  if (goMod !== null) {
    languages.push("go");
    markers["go.mod"] = true;
  }

  for (const file of ["requirements.txt", "pyproject.toml", "setup.py"]) {
    const content = await tryRead(projectPath, file);
    if (content !== null) {
      addLanguage(languages, "python");
      markers[file] = true;
    }
  }

  const csprojFiles = await findBySuffix(projectPath, ".csproj");
  const slnFiles = await findBySuffix(projectPath, ".sln");
  if (csprojFiles.length > 0 || slnFiles.length > 0) {
    languages.push("csharp");
    if (csprojFiles.length > 0) markers[csprojFiles[0]] = true;
    if (slnFiles.length > 0) markers[slnFiles[0]] = true;
  }

  const pomXml = await tryRead(projectPath, "pom.xml");
  if (pomXml !== null) {
    languages.push("java");
    markers["pom.xml"] = true;
  }

  const buildGradle = await tryRead(projectPath, "build.gradle");
  if (buildGradle !== null) {
    addLanguage(languages, "java");
    markers["build.gradle"] = true;
  }
}

/**
 * Detect languages from marker files inside a single subdirectory.
 * @param {string} projectPath
 * @param {string} subdirName
 * @param {string[]} languages
 * @param {object} markers
 */
async function detectSubdirMarkers(projectPath, subdirName, languages, markers) {
  const subdir = join(projectPath, subdirName);
  const prefix = `${subdirName}/`;

  const subPkg = await tryRead(projectPath, join(subdirName, "package.json"));
  if (subPkg !== null) {
    addLanguage(languages, "typescript");
    markers[`${prefix}package.json`] = true;
  }

  const subGoMod = await tryRead(projectPath, join(subdirName, "go.mod"));
  if (subGoMod !== null) {
    addLanguage(languages, "go");
    markers[`${prefix}go.mod`] = true;
  }

  for (const file of ["requirements.txt", "pyproject.toml"]) {
    const content = await tryRead(projectPath, join(subdirName, file));
    if (content !== null) {
      addLanguage(languages, "python");
      markers[`${prefix}${file}`] = true;
    }
  }

  for (const file of ["pom.xml", "build.gradle"]) {
    const content = await tryRead(projectPath, join(subdirName, file));
    if (content !== null) {
      addLanguage(languages, "java");
      markers[`${prefix}${file}`] = true;
    }
  }

  const subCsproj = await findBySuffix(subdir, ".csproj");
  const subSln = await findBySuffix(subdir, ".sln");
  if (subCsproj.length > 0 || subSln.length > 0) {
    addLanguage(languages, "csharp");
    if (subCsproj.length > 0) markers[`${prefix}${subCsproj[0]}`] = true;
    if (subSln.length > 0) markers[`${prefix}${subSln[0]}`] = true;
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

  await detectRootMarkers(projectPath, languages, markers);

  try {
    const entries = await readdir(projectPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      await detectSubdirMarkers(projectPath, entry.name, languages, markers);
    }
  } catch {
    // skip if root readdir fails
  }

  return { languages, markers };
}
