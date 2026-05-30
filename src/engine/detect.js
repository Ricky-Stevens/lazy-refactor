import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { LANGUAGE_EXTENSIONS } from "./files.js";

// Reverse map: extension → language, first definition wins. `typescript` is listed
// before `javascript` in LANGUAGE_EXTENSIONS, so .js/.jsx resolve to typescript
// (matching the rest of the engine, which handles JS under the typescript ruleset).
const EXT_TO_LANGUAGE = (() => {
  const map = new Map();
  for (const [lang, exts] of Object.entries(LANGUAGE_EXTENSIONS)) {
    if (lang === "common") continue;
    for (const ext of exts) if (!map.has(ext)) map.set(ext, lang);
  }
  return map;
})();

const SAMPLE_SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  "vendor",
  "coverage",
  "out",
  "target",
]);
const SAMPLE_MAX_DEPTH = 5;
const SAMPLE_MAX_FILES = 2000;

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
      // A package.json always resolves to "typescript" below (the engine handles JS under
      // the TS ruleset), so only the typescript marker is meaningful — no dead javascript flag.
      if (allDeps.typescript || allDeps["ts-node"] || allDeps.tsx) markers.typescript = true;
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
    for (const f of csprojFiles) markers[f] = true;
    for (const f of slnFiles) markers[f] = true;
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
    for (const f of subCsproj) markers[`${prefix}${f}`] = true;
    for (const f of subSln) markers[`${prefix}${f}`] = true;
  }
}

/**
 * Fallback detection: sample source-file extensions from a bounded recursive walk
 * and map them back to languages. Marker detection only inspects the root and its
 * immediate children, so a monorepo whose manifests live under packages/<pkg>/ would
 * otherwise yield NO languages — making `auto` resolve to an empty set and silently
 * scan nothing. This guarantees `auto` finds whatever source actually exists.
 * @param {string} projectPath
 * @returns {Promise<string[]>}
 */
async function sampleLanguagesByExtension(projectPath) {
  const found = [];
  let budget = SAMPLE_MAX_FILES;

  async function walk(dir, depth) {
    if (depth > SAMPLE_MAX_DEPTH || budget <= 0) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable subtree — skip, mirroring collectFiles
    }
    for (const entry of entries) {
      if (budget <= 0) return;
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        if (!SAMPLE_SKIP_DIRS.has(entry.name)) await walk(join(dir, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      budget--;
      const dot = entry.name.lastIndexOf(".");
      if (dot < 0) continue;
      const lang = EXT_TO_LANGUAGE.get(entry.name.slice(dot));
      if (lang) addLanguage(found, lang);
    }
  }

  await walk(projectPath, 0);
  return found;
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

  // Marker detection only looks at the root + immediate children. If that found
  // nothing (e.g. a monorepo with nested package manifests), fall back to sampling
  // actual source extensions so `auto` never resolves to an empty, no-op scan.
  if (languages.length === 0) {
    for (const lang of await sampleLanguagesByExtension(projectPath)) {
      addLanguage(languages, lang);
    }
    if (languages.length > 0) markers._extensionFallback = true;
  }

  return { languages, markers };
}
