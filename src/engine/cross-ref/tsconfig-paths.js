import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * tsconfig `paths` alias resolution for dead-code reachability.
 *
 * `reachability.js` resolves RELATIVE specifiers (`./x`, `../x`) in `export * from`
 * barrels and dynamic `import()` to corpus files, exempting them from dead-code.
 * Alias specifiers (`@/…`, `~/…`) were the documented residual: a barrel or dynamic
 * import written `export * from '@/components'` couldn't be resolved, so the target's
 * exports looked dead and the fixer's remedy is DELETION. On a path-aliased Next.js
 * app that's the dominant dead-code false positive. This module reads the project's
 * tsconfig `paths`/`baseUrl` and returns a resolver so those aliases resolve too.
 *
 * Best-effort by design: any read/parse failure yields null (no aliases — the prior
 * behaviour), so a missing or malformed tsconfig never crashes a scan.
 */

/**
 * Strip line and block comments, string-aware so a slash-star sequence INSIDE a
 * string (e.g. the path glob "@/" + "*") is never mistaken for a comment opener.
 * A regex strip can't do this — it would delete from that in-string slash-star to
 * the next close-comment. JSON strings are double-quoted, so we only track the
 * double-quote.
 */
function stripJsonComments(text) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const c2 = text[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += c2 ?? "";
        i++;
      } else if (c === '"') {
        inStr = false;
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === "/" && c2 === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && c2 === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++; // land on the '/' of '*/'; loop's i++ steps past it
    } else {
      out += c;
    }
  }
  return out;
}

/** Parse JSONC (tsconfig allows comments + trailing commas). Returns null on failure. */
function parseJsonc(text) {
  try {
    const noTrailingCommas = stripJsonComments(text).replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(noTrailingCommas);
  } catch {
    return null;
  }
}

async function readTsconfig(file) {
  try {
    return parseJsonc(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Merge compilerOptions across one `extends` level (string form only — the common
 * "extends a shared base" setup). The child wins; `paths` are shallow-merged.
 */
async function resolveCompilerOptions(tsconfigPath, cfg) {
  let opts = cfg.compilerOptions ?? {};
  if (cfg.extends && typeof cfg.extends === "string") {
    const ref = cfg.extends.endsWith(".json") ? cfg.extends : `${cfg.extends}.json`;
    const baseFile = resolve(dirname(tsconfigPath), ref);
    const base = await readTsconfig(baseFile);
    if (base?.compilerOptions) {
      opts = {
        ...base.compilerOptions,
        ...opts,
        paths: { ...base.compilerOptions.paths, ...opts.paths },
      };
    }
  }
  return opts;
}

/**
 * Load a path-alias resolver from `<rootDir>/tsconfig.json`. Returns a function
 * mapping an alias specifier to candidate ABSOLUTE base paths (extension/index
 * probing is the caller's job, mirroring relative resolution), or null when the
 * project declares no `paths`.
 * @param {string} rootDir - scan root (project root for a normal scan)
 * @returns {Promise<((spec: string) => string[]) | null>}
 */
export async function loadAliasResolver(rootDir) {
  const tsconfigPath = join(rootDir, "tsconfig.json");
  const cfg = await readTsconfig(tsconfigPath);
  if (!cfg) return null;

  const opts = await resolveCompilerOptions(tsconfigPath, cfg);
  const paths = opts.paths;
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) return null;

  const baseDir = resolve(rootDir, typeof opts.baseUrl === "string" ? opts.baseUrl : ".");

  // Precompile each "alias/*" pattern into prefix/suffix + target templates.
  const entries = Object.entries(paths)
    .filter(([, targets]) => Array.isArray(targets))
    .map(([pattern, targets]) => {
      const star = pattern.indexOf("*");
      return {
        pattern,
        hasStar: star !== -1,
        prefix: star === -1 ? pattern : pattern.slice(0, star),
        suffix: star === -1 ? "" : pattern.slice(star + 1),
        targets,
      };
    });
  if (entries.length === 0) return null;

  return (spec) => {
    const out = [];
    for (const e of entries) {
      let captured = null;
      if (e.hasStar) {
        if (
          spec.length >= e.prefix.length + e.suffix.length &&
          spec.startsWith(e.prefix) &&
          spec.endsWith(e.suffix)
        ) {
          captured = spec.slice(e.prefix.length, spec.length - e.suffix.length);
        }
      } else if (spec === e.pattern) {
        captured = "";
      }
      if (captured === null) continue;
      for (const t of e.targets) {
        if (typeof t !== "string") continue;
        out.push(resolve(baseDir, e.hasStar ? t.replace("*", captured) : t));
      }
    }
    return out;
  };
}
